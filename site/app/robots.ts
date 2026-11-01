import type { MetadataRoute } from "next";

/** Link-preview bots are logged out, so the public pages and the preview images are open to them. Everything behind
    the login (the app pages and the API) is listed explicitly. The pages also carry noindex. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/login", "/opengraph-image", "/twitter-image"],
      disallow: ["/api/", "/ask", "/clips", "/future", "/guests", "/insights", "/prep", "/saved"],
    },
  };
}
