import { expect, it } from "vitest";
import { openPelicanPreview, pelicanFrame, controlPelicanPreview, preparePelicanPreview } from "./renderer-workers";
it("never returns generated HTML or launches a renderer in the free Worker", async () => {
  for (const operation of [() => openPelicanPreview("<script>untrusted()</script>"), () => pelicanFrame("id"), () => controlPelicanPreview("id", "resume"), () => preparePelicanPreview("<svg/> // raw")])
    await expect(operation()).rejects.toMatchObject({ code: "PELICAN_UNAVAILABLE_ON_FREE_CLOUD", status: 503 });
});
