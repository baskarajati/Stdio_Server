export const dynamic = 'force-dynamic';

/** A liveness check for the deployment pipeline. */
export function GET() {
  return Response.json({ status: 'ok', service: 'stdio-web' });
}
