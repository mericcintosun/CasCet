import type { MetadataRoute } from "next";
import { SITE_ROUTES, SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return SITE_ROUTES.map((route) => ({
    url: route === "/" ? SITE_URL : `${SITE_URL}${route}`,
    changeFrequency: route === "/dashboard" || route === "/explorer" ? "daily" : "weekly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
