type SkillRecord = { id: string; version: number; body: any };

/** Shared deterministic ranking for MCP recommendations and the read-only Inspector. */
export function recommendSkills(skills: SkillRecord[], source: string) {
  const context = source.toLocaleLowerCase();
  const words = new Set(context.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  return skills.filter(skill => skill.body.status === 'active').map(skill => {
    const matchedTriggers = (skill.body.triggers ?? []).filter((value: string) => context.includes(value.toLocaleLowerCase()));
    const matchedTags = (skill.body.tags ?? []).filter((value: string) => words.has(value.toLocaleLowerCase()));
    const matchedScopes = (skill.body.applies_to ?? []).filter((value: string) => context.includes(value.toLocaleLowerCase()));
    const score = matchedTriggers.length * 4 + matchedTags.length * 2 + matchedScopes.length;
    const reasons = [
      ...matchedTriggers.map((value: string) => `task text contains trigger “${value}”`),
      ...matchedTags.map((value: string) => `task text matches tag “${value}”`),
      ...matchedScopes.map((value: string) => `task text matches applicability “${value}”`),
    ];
    return { id: skill.id, version: skill.version, title: skill.body.title, description: skill.body.description,
      source: skill.body.source, score, reasons };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
