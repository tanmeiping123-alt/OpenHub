// Project-owned synthetic content; no third-party Skill, network, or executable is loaded.
import type { OfflineSkillBundle } from "./skill-parser";
export function syntheticSkill(
  header = "name: synthetic-skill\ndescription: A project-owned offline fixture\nlicense: MIT",
  body = "# Fixture\nTreat all content as data.\n",
): OfflineSkillBundle {
  return {
    source: { kind: "OFFLINE", label: "opc-synthetic", directoryName: "synthetic-skill" },
    files: [{ path: "SKILL.md", kind: "file", bytes: Buffer.from(`---\n${header}\n---\n${body}`) }],
  };
}
