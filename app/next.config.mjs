/** Static export: `npm run build` writes ./out, which Vercel or any static host can serve. */
const nextConfig = { output: "export", images: { unoptimized: true } };
export default nextConfig;
