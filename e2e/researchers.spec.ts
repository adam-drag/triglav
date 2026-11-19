import { BASE, clientFetch, expect, openLive, test } from './fixtures.ts';

// The Researchers page: the kinds a persona receives, and what its runs cost (docs/plans/researcher-access.md, phase 1).
test('the Client picks the kinds a persona receives and sees its cost for the last 7 days', async ({ page, consoleErrors: _ }) => {
  const nickname = `kinds-e2e-${Date.now()}`;
  const res = await clientFetch(`${BASE}/api/research/personas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname, focus: 'e2e kinds', repo_path: '/repo', runtime: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium' }),
  });
  expect(res.ok).toBe(true);
  const { id } = (await res.json()) as { id: string };
  try {
    await openLive(page, 'research');
    const row = page.getByTestId('persona').filter({ has: page.getByLabel(`${nickname} name`) });
    // A new persona receives every kind.
    for (const kind of ['Questions', 'Proposals', 'Review rounds', 'Client decisions']) await expect(row.getByLabel(`${nickname} receives ${kind}`)).toBeChecked();
    // The box shows the saved value, so it changes once the save is back (like the On box).
    await row.getByLabel(`${nickname} receives Client decisions`).click();
    await expect(row.getByLabel(`${nickname} receives Client decisions`)).not.toBeChecked();
    const saved = (await (await clientFetch(`${BASE}/api/research`)).json()) as { personas: { id: string; kinds: string[] | null }[] };
    expect(saved.personas.find((p) => p.id === id)?.kinds).toEqual(['question', 'proposal', 'review']);
    // Ticking it again stores "all", so a kind added later reaches the persona too.
    await row.getByLabel(`${nickname} receives Client decisions`).click();
    await expect(row.getByLabel(`${nickname} receives Client decisions`)).toBeChecked();
    await expect.poll(async () => ((await (await clientFetch(`${BASE}/api/research`)).json()) as { personas: { id: string; kinds: string[] | null }[] }).personas.find((p) => p.id === id)?.kinds).toBeNull();

    await expect(page.getByTestId('persona-cost').filter({ hasText: nickname })).toContainText('0');
    await expect(page.getByTestId('claude-budget')).toContainText('Claude plan, shared with Staff and Seniors');
  } finally {
    await clientFetch(`${BASE}/api/research/personas/${id}`, { method: 'DELETE' });
  }
});
