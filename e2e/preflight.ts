/** Stops early with an instruction when the stack is not up. The tests never start it themselves. */
export default async function preflight() {
  const base = process.env.ORCH_E2E_URL ?? 'http://localhost:7401';
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(`The orchestrator at ${base} is not reachable (${(error as Error).message}). Start the e2e stack with: pnpm e2e:up`);
  }
}
