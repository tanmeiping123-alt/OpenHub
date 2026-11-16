-- Additive: keep all historical executions, pricing snapshots and receipts unchanged.
ALTER TABLE model_executions
  ADD COLUMN requested_strength text CHECK (requested_strength IN ('default','off','high','max')),
  ADD COLUMN output_token_limit integer CHECK (output_token_limit > 0),
  ADD COLUMN reasoning_token_reserve integer CHECK (reasoning_token_reserve >= 0),
  ADD COLUMN reasoning_tokens integer CHECK (reasoning_tokens >= 0 AND reasoning_tokens <= completion_tokens);

ALTER TABLE model_pricing_snapshots
  ADD COLUMN native_currency text CHECK (native_currency IN ('CNY')),
  ADD COLUMN native_input_per_million numeric(16,10),
  ADD COLUMN native_output_per_million numeric(16,10),
  ADD COLUMN native_cache_hit_per_million numeric(16,10),
  ADD COLUMN budget_usd_per_native_unit numeric(16,10);

-- Vendor prices: https://siliconflow.cn/pricing, captured 2026-11-06.
-- The fixed 0.20 USD/CNY factor is a conservative LOCAL BUDGET coefficient,
-- NOT a live exchange rate, provider USD quote, discount, or settled invoice.
INSERT INTO model_pricing_snapshots
 (id,provider,requested_model,product_version,pricing_window,
  input_cache_hit_usd_per_million,input_cache_miss_usd_per_million,output_usd_per_million,
  source_url,effective_at,valid_until,native_currency,native_input_per_million,
  native_output_per_million,native_cache_hit_per_million,budget_usd_per_native_unit)
SELECT id,'siliconflow',model,model,'PEAK',hit * 0.20,input * 0.20,output * 0.20,
 'https://siliconflow.cn/pricing','2026-11-06T00:00:00Z'::timestamptz,
 '2026-12-06T00:00:00Z'::timestamptz,'CNY',input,output,hit,0.20
FROM (VALUES
 ('mps_sf_glm53flash_20261106','zai-org/GLM-5.3-Flash',0.80,2.80,0.23),
 ('mps_sf_hy4_20261106','tencent/Hy4-preview',6.00,18.00,0.30),
 ('mps_sf_glm53_20261106','zai-org/GLM-5.3',8.00,28.00,2.00),
 ('mps_sf_ds4pro_20261106','deepseek-ai/DeepSeek-V4-Pro',12.00,24.00,1.00)
) AS prices(id,model,input,output,hit);

ALTER TABLE optimization_records DROP CONSTRAINT optimization_records_source_check;
ALTER TABLE optimization_records DROP CONSTRAINT optimization_records_live_execution_check;
ALTER TABLE optimization_records ADD CONSTRAINT optimization_records_source_check
 CHECK (source IN ('MOCK_SIMULATED','DEEPSEEK_LIVE_OPTIMIZATION','SILICONFLOW_LIVE_OPTIMIZATION'));
ALTER TABLE optimization_records ADD CONSTRAINT optimization_records_source_execution_check
 CHECK ((source='MOCK_SIMULATED' AND model_execution_id IS NULL) OR
        (source IN ('DEEPSEEK_LIVE_OPTIMIZATION','SILICONFLOW_LIVE_OPTIMIZATION') AND model_execution_id IS NOT NULL));
ALTER TABLE playground_sessions DROP CONSTRAINT playground_sessions_source_check;
ALTER TABLE playground_sessions DROP CONSTRAINT playground_sessions_live_execution_check;
ALTER TABLE playground_sessions ADD CONSTRAINT playground_sessions_source_check
 CHECK (source IN ('MOCK_SIMULATED','DEEPSEEK_LIVE_PLAYGROUND','SILICONFLOW_LIVE_PLAYGROUND'));
ALTER TABLE playground_sessions ADD CONSTRAINT playground_sessions_source_execution_check
 CHECK ((source='MOCK_SIMULATED' AND model_execution_id IS NULL) OR
        (source IN ('DEEPSEEK_LIVE_PLAYGROUND','SILICONFLOW_LIVE_PLAYGROUND') AND model_execution_id IS NOT NULL));
ALTER TABLE model_comparison_results DROP CONSTRAINT model_comparison_results_source_check;
ALTER TABLE model_comparison_results ADD CONSTRAINT model_comparison_results_source_check
 CHECK (source IN ('MOCK_SIMULATED','DEEPSEEK_LIVE_PLAYGROUND','SILICONFLOW_LIVE_PLAYGROUND'));
