import { httpRouter } from "convex/server";
import { auth } from "./auth";

// Convex Auth serves its token endpoints over HTTP actions; without this
// router the Password provider can't complete sign-in.
const http = httpRouter();

auth.addHttpRoutes(http);

export default http;
