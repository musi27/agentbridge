// Vercel Node function entry: one http.Server for every route (vercel.json rewrites /(.*) here).
import { relayFromEnv } from './env.ts';

export default relayFromEnv().server;
