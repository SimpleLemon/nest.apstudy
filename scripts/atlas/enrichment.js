const { undergraduateCareers } = require('./metadata');
const { AtlasAccessRefused, fetchAllResults, sectionIdentity } = require('./transport');
const { normalizeRequirements } = require('./atlasCourseUtils');

async function enrichRequirements(rows, metadata, srcdb, transport, options = {}) {
  const tags = new Map();
  const errors = [];
  for (const requirement of options.requirements || []) {
    try {
      for (const career of undergraduateCareers(metadata)) {
        const result = await fetchAllResults(transport.post, srcdb, [
          { field: metadata.career_field, value: career.value },
          { field: options.requirementField || 'requirement', value: requirement },
        ], options);
        if (result.rows.length > (options.requirementMaxResults || 2500)) throw new Error('Requirement query exceeded configured maximum; filter may be ignored.');
        for (const row of result.rows) {
          const key = sectionIdentity(row);
          if (!tags.has(key)) tags.set(key, new Set());
          tags.get(key).add(requirement);
        }
      }
    } catch (error) {
      if (error instanceof AtlasAccessRefused) throw error;
      errors.push({ requirement, message: error.message });
    }
  }
  return { rows: rows.map(row => ({ ...row, requirements: normalizeRequirements(row,
    { requirements: [...(tags.get(sectionIdentity(row)) || [])] }) })),
  requirements: { status: !(options.requirements || []).length ? 'disabled' : errors.length ? 'partial' : 'complete', errors } };
}

module.exports = { enrichRequirements };
