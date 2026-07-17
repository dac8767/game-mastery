// Tells Convex to accept the JWTs that Convex Auth itself issues.
// CONVEX_SITE_URL is set automatically on every deployment.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
