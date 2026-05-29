const DAY_MAP = {
  '0': 'Mon',
  '1': 'Tue',
  '2': 'Wed',
  '3': 'Thu',
  '4': 'Fri',
  '5': 'Sat',
  '6': 'Sun',
};

function parseEnvList(value) {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseMeetingTimes(raw) {
  let parsed = [];
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []);
  } catch {
    return [];
  }

  return parsed.map(m => ({
    day: DAY_MAP[m.meet_day] ?? `Day${m.meet_day}`,
    start: String(m.start_time),
    end: String(m.end_time),
  }));
}

function parseEnrollmentStatus(code) {
  const map = { 'O': 'Open', 'C': 'Closed', 'W': 'Waitlist' };
  return map[code] ?? code;
}

function splitCourseCode(code) {
  const trimmed = (code ?? '').trim();
  const spaceIdx = trimmed.lastIndexOf(' ');
  if (spaceIdx === -1) return { subject: trimmed, catalog: 'UNKNOWN' };
  return {
    subject: trimmed.substring(0, spaceIdx).trim(),
    catalog: trimmed.substring(spaceIdx + 1).trim(),
  };
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(html) {
  return decodeHtmlEntities(String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstPresent(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseInstructors(raw) {
  const source = firstPresent(raw, ['instructors', 'instr', 'instructor']);
  if (Array.isArray(source)) {
    return source
      .map(item => {
        if (typeof item === 'object' && item !== null) {
          const name = firstPresent(item, ['name', 'instructor', 'displayName']);
          const email = firstPresent(item, ['email', 'mail']);
          return name ? { name, email: email ?? null } : null;
        }
        const name = String(item ?? '').trim();
        return name ? { name, email: null } : null;
      })
      .filter(Boolean);
  }
  return String(source ?? '')
    .split(/\s*(?:;|\|)\s*/)
    .map(name => name.trim())
    .filter(name => name && name !== 'Staff' && name !== 'TBA')
    .map(name => ({
      name,
      email: firstPresent(raw, ['instructor_email', 'email', 'mail']) ?? null,
    }));
}

function parseCatalogCourseCards(html) {
  const courses = {};
  const cardPattern = /<div class="card"><div class="card-header"[\s\S]*?<button[^>]*>([\s\S]*?)<\/button>[\s\S]*?<div class="card-body">([\s\S]*?)<\/div><\/div><\/div>/g;
  let match;
  while ((match = cardPattern.exec(html))) {
    const heading = stripTags(match[1]);
    const headingMatch = /^([A-Z_]+)\s+([A-Z0-9]+[A-Z]?):\s*(.+)$/.exec(heading);
    if (!headingMatch) continue;

    const [, subject, catalog, title] = headingMatch;
    const body = match[2];
    const descriptionMatch = /<p class="card-text">([\s\S]*?)<\/p>/.exec(body);
    const fields = {};
    const fieldPattern = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(body))) {
      fields[stripTags(fieldMatch[1])] = stripTags(fieldMatch[2]);
    }

    const normalizedFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value])
    );
    const requisites = normalizedFields.requisites && normalizedFields.requisites !== 'None'
      ? normalizedFields.requisites
      : null;
    courses[`${subject}|${catalog}`] = {
      course_title: title,
      credit_hours: normalizedFields['credit hours'] ?? null,
      requirement_designation: normalizedFields.ger ?? normalizedFields.requirements ?? null,
      course_description: descriptionMatch ? stripTags(descriptionMatch[1]) : null,
      course_notes: firstPresent(normalizedFields, ['course notes', 'notes']) ?? requisites,
      requisites,
      cross_listed: normalizedFields['cross-listed'] && normalizedFields['cross-listed'] !== 'None'
        ? normalizedFields['cross-listed']
        : null,
    };
  }
  return courses;
}

function buildCourseObject(courseCode, sections, termLabel, srcdb, catalogCourseMap = {}) {
  const { subject, catalog } = splitCourseCode(courseCode);
  const catalogInfo = catalogCourseMap[`${subject}|${catalog}`] ?? {};

  const structuredSections = sections.map(s => ({
    crn: s.crn ?? null,
    section_number: s.no ?? null,
    schedule_type: s.schd ?? null,
    instructor: s.instr ?? null,
    instructors: parseInstructors(s),
    location: firstPresent(s, ['location', 'loc', 'room', 'building', 'bldg_room', 'bldgRoom']),
    enrollment_status: parseEnrollmentStatus(s.enrl_stat),
    enrollment_count: s.total ?? null,
    is_cancelled: !!(s.isCancelled && s.isCancelled !== ''),
    schedule: {
      display: s.meets ?? null,
      meetings: parseMeetingTimes(s.meetingTimes),
    },
  }));

  const types = structuredSections.reduce(
    (acc, s) => {
      const t = s.schedule_type;
      if (t === 'LEC') acc.lectures++;
      else if (t === 'LAB') acc.labs++;
      else if (t === 'DIS') acc.discussions++;
      else acc.other++;

      if (s.enrollment_status === 'Open') acc.open++;
      else if (s.enrollment_status === 'Closed') acc.closed++;
      else if (s.enrollment_status === 'Waitlist') acc.waitlisted++;
      return acc;
    },
    { lectures: 0, labs: 0, discussions: 0, other: 0, open: 0, closed: 0, waitlisted: 0 }
  );

  const instructorsSet = new Set(
    sections
      .map(s => s.instr)
      .filter(i => i && i !== 'Staff' && i.trim() !== '')
  );

  const startDate = sections[0]?.start_date ?? null;
  const endDate = sections[0]?.end_date ?? null;

  return {
    course_code: courseCode,
    course_title: sections[0]?.title ?? catalogInfo.course_title ?? null,
    subject,
    catalog_number: catalog,
    term: termLabel,
    srcdb,
    credit_hours: catalogInfo.credit_hours ?? firstPresent(sections[0], ['credit_hours', 'credits', 'hours']),
    requirement_designation: catalogInfo.requirement_designation ?? firstPresent(sections[0], ['requirement_designation', 'ger', 'attributes']),
    course_description: catalogInfo.course_description ?? firstPresent(sections[0], ['course_description', 'description', 'desc']),
    course_notes: catalogInfo.course_notes ?? firstPresent(sections[0], ['course_notes', 'notes']),
    requisites: catalogInfo.requisites ?? null,
    cross_listed: catalogInfo.cross_listed ?? null,
    date_range: {
      start: startDate,
      end: endDate,
    },
    sections: structuredSections,
    section_summary: {
      total_sections: structuredSections.length,
      ...types,
    },
    instructors_unique: [...instructorsSet].sort(),
    scraped_at: new Date().toISOString(),
  };
}

module.exports = {
  buildCourseObject,
  decodeHtmlEntities,
  firstPresent,
  parseCatalogCourseCards,
  parseEnrollmentStatus,
  parseEnvList,
  parseInstructors,
  parseMeetingTimes,
  splitCourseCode,
  stripTags,
};
