import type { RecordData } from './store.js';
type EventData = { actor: string; action: string; at: string; record_id: string };
type Task = RecordData & { dependencies?: { id: string; title: string; status: string }[] };
export function operationsView(tasks: Task[], events: EventData[], now = Date.now()) {
  const quietAfter = 10 * 60 * 1000;
  const open = tasks.filter(t => !['done', 'cancelled'].includes(t.body.status));
  const ready: { id: string; title: string; reason: string }[] = [];
  const attention: { id: string; title: string; reason: string; severity: string }[] = [];
  const agents = new Map<string, { actor: string; last_at: string | null; last_action: string | null; tasks: { id: string; title: string; progress: string; state: string; lease_until: string | null; last_at: string }[] }>();
  // Latest actor event is selected by timestamp, not by the input array's order.
  const latest = new Map<string, EventData>();
  for (const event of events) if (!latest.has(event.actor) || event.at > latest.get(event.actor)!.at) latest.set(event.actor, event);
  for (const task of open) {
    const b = task.body;
    const unmet = (task.dependencies ?? []).filter(d => d.status !== 'done');
    const leased = !!b.owner && Date.parse(b.lease_expires_at ?? '') > now;
    const expired = !!b.owner && !!b.lease_expires_at && !leased;
    const quiet = leased && now - Date.parse(task.updated_at) >= quietAfter;
    let state = expired ? 'Lease expired' : b.status === 'blocked' || unmet.length ? 'Blocked' : quiet ? 'No update for 10m+' : leased ? 'Claimed' : 'Unassigned';
    if (expired) attention.push({ id: task.id, title: b.title, reason: 'Lease expired. Work can be reclaimed after checking current state.', severity: 'expired' });
    if (b.status === 'blocked' || unmet.length) attention.push({ id: task.id, title: b.title,
      reason: unmet.length ? `Waiting for ${unmet.slice(0, 5).map(d => d.title).join(', ')}${unmet.length > 5 ? ` and ${unmet.length - 5} more` : ''}.` : (b.reason ?? b.blocked_reason ?? 'Marked blocked; inspect the task for context.'), severity: 'blocked' });
    if (quiet && !unmet.length && b.status !== 'blocked') attention.push({ id: task.id, title: b.title, reason: 'No task update for at least 10 minutes. Lease is still valid; this does not prove a stall.', severity: 'quiet' });
    if (!unmet.length && b.status !== 'blocked' && (b.status === 'ready' || (expired && ['in_progress', 'review'].includes(b.status)))) ready.push({ id: task.id, title: b.title, reason: expired ? 'Expired lease · eligible to reclaim' : 'Dependencies satisfied' });
    if (b.owner) {
      if (!agents.has(b.owner)) { const event = latest.get(b.owner); agents.set(b.owner, { actor: b.owner, last_at: event?.at ?? null, last_action: event?.action ?? null, tasks: [] }); }
      agents.get(b.owner)!.tasks.push({ id: task.id, title: b.title, progress: b.progress ?? '', state, lease_until: b.lease_expires_at ?? null, last_at: task.updated_at });
    }
  }
  // Sessions alone never imply presence. Recent actors with no owned work are labelled as recorded activity.
  for (const [actor, event] of latest) if (!agents.has(actor) && now - Date.parse(event.at) <= quietAfter && Date.parse(event.at) <= now) agents.set(actor, { actor, last_at: event.at, last_action: event.action, tasks: [] });
  const rank = { expired: 0, blocked: 1, quiet: 2 };
  attention.sort((a, b) => rank[a.severity as keyof typeof rank] - rank[b.severity as keyof typeof rank] || a.id.localeCompare(b.id));
  const priority = new Map(tasks.map(t => [t.id, bPriority(t)]));
  ready.sort((a,b) => priority.get(a.id)! - priority.get(b.id)! || a.id.localeCompare(b.id));
  return { agents: [...agents.values()].sort((a,b) => Number(b.tasks.length > 0) - Number(a.tasks.length > 0) || (b.last_at ?? '').localeCompare(a.last_at ?? '') || a.actor.localeCompare(b.actor)).slice(0, 30).map(agent => ({ ...agent, task_count: agent.tasks.length, tasks: agent.tasks.slice(0, 6) })),
    attention: attention.slice(0, 30), ready: ready.slice(0, 30),
    totals: { agents: agents.size, owned: open.filter(t => !!t.body.owner).length, attention: attention.length, ready: ready.length, done: tasks.filter(t => t.body.status === 'done').length },
    rules: 'Quiet: no task update for 10 minutes while a lease remains valid. Actor labels are caller supplied. Recorded actions and ownership do not prove a process is running.' };
}
function bPriority(task: Task) { return typeof task.body.priority === 'number' ? task.body.priority : 2; }
