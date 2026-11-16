import "server-only";
import publication from "./catalog/featured-20261105-01.json";
import { isFeaturedPublication, type FeaturedPublication } from "../../featured-skills";

export function getFeaturedPublication(): FeaturedPublication {
  if (!isFeaturedPublication(publication)) throw new Error("FEATURED_CATALOG_INVALID");
  // One complete release; never a mixture of in-progress observations. No DB or network.
  return structuredClone(publication);
}
