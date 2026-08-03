const test = require('node:test');
const assert = require('node:assert/strict');
// From source this resolves to TypeScript; from dist/test it resolves to the
// compiled JavaScript beside the other runtime modules.
const { validateSkill } = require('../src/core/skill-registry');

test('skill manifests are typed, immutable, and reject invalid authority declarations', () => {
  const skill = validateSkill({ id:'notes', name:'Notes', version:'1.2.3', kind:'native', permissions:['notes:read'], commands:['search'] });
  assert.equal(skill.id, 'notes');
  assert.equal(Object.isFrozen(skill), true);
  assert.throws(() => validateSkill({ id:'Notes', name:'Notes', version:'dev', kind:'shell', permissions:[], commands:[] }), /id must be kebab-case/);
});
