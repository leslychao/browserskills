import type { TemplateProfile } from '../src/adapter.js';
export const fixtureProfile = (origin: string): TemplateProfile => ({
  id: 'owned-fixture-v1', origin, mediaOrigins: [origin],
  root: '#task', instructions: ['#instructions'], question: '#question',
  options: 'input[type="radio"]', submit: '#submit', image: '#image', audio: '#audio',
  taskAttribute: 'data-task-id', projectAttribute: 'data-project-id',
  success: '#success', error: '#error', complete: '#complete',
});
