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

function normalizeCampus(value, subject) {
  const raw = String(value ?? '').trim();
  const lowered = raw.toLowerCase();
  if (lowered.includes('oxford') || lowered.startsWith('oxf@')) return 'Oxford';
  if (lowered.includes('atlanta') || lowered.includes('main') || lowered === 'emory' || lowered.startsWith('atl@')) {
    return 'Atlanta';
  }
  const upperSubject = String(subject ?? '').toUpperCase();
  if (upperSubject.startsWith('OX') || upperSubject.endsWith('_OX')) return 'Oxford';
  return raw || null;
}

function parseSeatsHtml(html) {
  const text = stripTags(html);
  const capacityMatch = /Maximum Enrollment\D*(\d+)/i.exec(text);
  const availableMatch = /Seats Avail\D*(\d+)/i.exec(text);
  const waitlistMatch = /Waitlist Total\D*(\d+)\s+of\s+(\d+)/i.exec(text);
  return {
    enrollment_capacity: capacityMatch ? Number.parseInt(capacityMatch[1], 10) : null,
    seats_available: availableMatch ? Number.parseInt(availableMatch[1], 10) : null,
    waitlist_total: waitlistMatch ? Number.parseInt(waitlistMatch[1], 10) : null,
    waitlist_capacity: waitlistMatch ? Number.parseInt(waitlistMatch[2], 10) : null,
  };
}

function parseMeetingLocation(html) {
  const source = String(html ?? '');
  const linkMatch = /\bin\s+<a[^>]*>([^<]+)<\/a>/i.exec(source);
  if (linkMatch) return stripTags(linkMatch[1]);
  const plainMatch = /\bin\s+([^<]+?)(?:<\/span>|$)/i.exec(source);
  return plainMatch ? stripTags(plainMatch[1]) : null;
}

function cellValue(html) {
  return stripTags(html).replace(/^[^:]+:\s*/, '').trim();
}

function parseCampusFromAllSections(html, crn, sectionNumber) {
  const source = String(html ?? '');
  if (!source) return null;
  const wantedCrn = String(crn ?? '').trim();
  const wantedSection = String(sectionNumber ?? '').trim();
  const rowPattern = /<a[^>]*class="course-section"[^>]*>([\s\S]*?)<\/a>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(source))) {
    const rowHtml = rowMatch[1];
    const rowCrn = cellValue((/course-section-crn[^>]*>([\s\S]*?)<\/div>/i.exec(rowHtml) || [])[1] || '');
    const rowSection = cellValue((/course-section-section[^>]*>([\s\S]*?)<\/div>/i.exec(rowHtml) || [])[1] || '');
    if (wantedCrn && rowCrn !== wantedCrn) continue;
    if (!wantedCrn && wantedSection && rowSection !== wantedSection) continue;
    const campus = cellValue((/course-section-camp[^>]*>([\s\S]*?)<\/div>/i.exec(rowHtml) || [])[1] || '');
    return campus || null;
  }
  return null;
}

function parseInstructorDetailHtml(html) {
  const source = String(html ?? '');
  if (!source) return [];
  const instructors = [];
  const blockPattern = /<div class="instructor-detail">([\s\S]*?)<\/div>\s*(?=<div class="instructor-detail">|<\/div>\s*<\/div>|$)/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(source))) {
    const block = blockMatch[1];
    const name = stripTags((/instructor-name[^>]*>([\s\S]*?)<\/div>/i.exec(block) || [])[1] || '');
    const emailMatch = /mailto:([^"'>\s]+)/i.exec(block);
    const role = stripTags((/instructor-role[^>]*>([\s\S]*?)<\/div>/i.exec(block) || [])[1] || '');
    if (name) {
      instructors.push({
        name,
        email: emailMatch ? emailMatch[1] : null,
        role: role || null,
      });
    }
  }
  return instructors;
}

function parseGradingModeOptions(value) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseAtlasDetailsPayload(details, searchRow = {}) {
  if (!details || typeof details !== 'object' || details.fatal) return {};
  const crn = String(details.crn ?? searchRow.crn ?? '').trim();
  const sectionNumber = String(details.section ?? searchRow.no ?? searchRow.section_number ?? '').trim();
  const seats = parseSeatsHtml(details.seats);
  const campusDescription = parseCampusFromAllSections(details.all_sections, crn, sectionNumber);
  const requirementDesignation = stripTags(details.clss_assoc_rqmnt_designt_html) || null;
  const instructorDetails = parseInstructorDetailHtml(details.instructordetail_html);
  const enrollmentStatus = stripTags(details.enrl_stat_html)
    || parseEnrollmentStatus(searchRow.enrl_stat ?? searchRow.enrollment_status);
  const creditHours = details.credit_hours_options ?? stripTags(details.hours_html) ?? null;

  return {
    atlas_key: String(details.key ?? searchRow.key ?? '').trim() || null,
    credit_hours: creditHours,
    enrollment_capacity: seats.enrollment_capacity,
    seats_available: seats.seats_available,
    waitlist_total: seats.waitlist_total,
    waitlist_capacity: seats.waitlist_capacity,
    grading_mode: details.grademode_code ?? null,
    grading_mode_options: parseGradingModeOptions(details.gmods),
    instruction_method: details.inst_method_code ?? null,
    enrollment_status: enrollmentStatus,
    requirement_designation: requirementDesignation,
    requirements: normalizeRequirements({ requirement_designation: requirementDesignation }),
    campus_description: campusDescription,
    location: parseMeetingLocation(details.meeting_html),
    course_description: stripTags(details.description) || null,
    course_notes: stripTags(details.clssnotes) || null,
    typically_offered: stripTags(details.crse_typoff_html) || null,
    instructors: instructorDetails.length ? instructorDetails : null,
    instructor: instructorDetails[0]?.name ?? null,
    date_range: parseDatesHtml(details.dates_html, searchRow),
  };
}

function parseDatesHtml(value, searchRow = {}) {
  const text = stripTags(value);
  const match = /(\d{4}-\d{2}-\d{2})\s+through\s+(\d{4}-\d{2}-\d{2})/i.exec(text);
  if (match) {
    return { start: match[1], end: match[2] };
  }
  if (searchRow.start_date || searchRow.end_date) {
    return { start: searchRow.start_date ?? null, end: searchRow.end_date ?? null };
  }
  return null;
}

function mergeSectionWithDetails(searchRow, detailsPayload) {
  const parsed = parseAtlasDetailsPayload(detailsPayload, searchRow);
  const { subject } = splitCourseCode(searchRow.code ?? searchRow.course_code ?? '');
  const campusDescription = parsed.campus_description
    ?? firstPresent(searchRow, ['campus', 'campus_description', 'campusDescription', 'campus_descr', 'campusDescr']);
  return {
    ...searchRow,
    ...parsed,
    campus: normalizeCampus(campusDescription, subject),
    campus_description: campusDescription,
    instructors: parsed.instructors ?? parseInstructors(searchRow),
    instructor: parsed.instructor ?? searchRow.instr ?? searchRow.instructor ?? null,
  };
}

function pushUniqueRequirement(values, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    value.forEach(item => pushUniqueRequirement(values, item));
    return;
  }
  if (typeof value === 'object') {
    ['name', 'label', 'description', 'value', 'text'].forEach(key => pushUniqueRequirement(values, value[key]));
    return;
  }
  const text = String(value).trim();
  if (text && !values.includes(text)) values.push(text);
}

function normalizeRequirements(...sources) {
  const values = [];
  const keys = [
    'requirement_designation',
    'requirements',
    'requirement',
    'requirement_description',
    'requirement_descriptions',
    'ger',
    'ge_req',
    'geReq',
    'rqmt',
    'rqmt_descr',
    'attributes',
  ];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) pushUniqueRequirement(values, source[key]);
  }
  return values;
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
      requirements: normalizeRequirements({
        requirement_designation: normalizedFields.ger ?? normalizedFields.requirements ?? null,
      }),
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

  const structuredSections = sections.map(s => {
    const requirementValues = normalizeRequirements(s);
    const campusDescription = firstPresent(s, ['campus_description', 'campus', 'campusDescription', 'campus_descr', 'campusDescr']);
    const instructors = Array.isArray(s.instructors) && s.instructors.length
      ? s.instructors.map(item => ({
        name: item.name ?? item.instructor ?? null,
        email: item.email ?? item.mail ?? null,
        role: item.role ?? null,
      })).filter(item => item.name)
      : parseInstructors(s);
    const dateRange = s.date_range ?? parseDatesHtml(s.dates_html, s) ?? {
      start: s.start_date ?? null,
      end: s.end_date ?? null,
    };

    return {
      atlas_key: s.atlas_key ?? s.key ?? null,
      crn: s.crn ?? null,
      section_number: s.no ?? s.section_number ?? null,
      schedule_type: s.schd ?? s.schedule_type ?? null,
      instructor: s.instructor ?? s.instr ?? instructors[0]?.name ?? null,
      instructors,
      location: firstPresent(s, ['location', 'loc', 'room', 'building', 'bldg_room', 'bldgRoom']),
      campus: normalizeCampus(campusDescription, subject),
      campus_description: campusDescription,
      credit_hours: firstPresent(s, ['credit_hours', 'credits', 'hours', 'credit_hours_options']),
      requirement_designation: requirementValues[0] ?? null,
      requirements: requirementValues,
      grading_mode: s.grading_mode ?? s.grademode_code ?? null,
      grading_mode_options: s.grading_mode_options ?? parseGradingModeOptions(s.gmods),
      instruction_method: s.instruction_method ?? s.inst_method_code ?? null,
      enrollment_status: typeof s.enrollment_status === 'string' && !/^[OCW]$/i.test(s.enrollment_status)
        ? s.enrollment_status
        : parseEnrollmentStatus(s.enrl_stat ?? s.enrollment_status),
      enrollment_count: s.total ?? s.enrollment_count ?? null,
      enrollment_capacity: s.enrollment_capacity ?? null,
      seats_available: s.seats_available ?? null,
      waitlist_total: s.waitlist_total ?? null,
      waitlist_capacity: s.waitlist_capacity ?? null,
      is_cancelled: !!(s.isCancelled && s.isCancelled !== '') || !!s.is_cancelled,
      schedule: {
        display: s.meets ?? s.schedule?.display ?? null,
        meetings: parseMeetingTimes(s.meetingTimes ?? s.schedule?.meetings),
      },
      date_range: dateRange,
    };
  });

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
    structuredSections
      .flatMap(s => (s.instructors || []).map(i => i.name).concat(s.instructor ? [s.instructor] : []))
      .filter(i => i && i !== 'Staff' && i.trim() !== '')
  );

  const firstSection = sections[0] ?? {};
  const startDate = structuredSections[0]?.date_range?.start ?? firstSection.start_date ?? null;
  const endDate = structuredSections[0]?.date_range?.end ?? firstSection.end_date ?? null;

  return {
    course_code: courseCode,
    course_title: firstSection.title ?? catalogInfo.course_title ?? null,
    subject,
    catalog_number: catalog,
    term: termLabel,
    srcdb,
    credit_hours: firstPresent(structuredSections[0], ['credit_hours'])
      ?? catalogInfo.credit_hours
      ?? firstPresent(firstSection, ['credit_hours', 'credits', 'hours']),
    requirement_designation: normalizeRequirements(catalogInfo, ...structuredSections)[0] ?? null,
    requirements: normalizeRequirements(catalogInfo, ...structuredSections),
    campus: normalizeCampus(
      firstPresent(structuredSections[0], ['campus_description', 'campus']),
      subject
    ),
    campus_description: firstPresent(structuredSections[0], ['campus_description', 'campus']),
    course_description: firstSection.course_description
      ?? catalogInfo.course_description
      ?? stripTags(firstSection.description),
    course_notes: firstSection.course_notes
      ?? catalogInfo.course_notes
      ?? stripTags(firstSection.clssnotes),
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
  mergeSectionWithDetails,
  normalizeCampus,
  normalizeRequirements,
  parseAtlasDetailsPayload,
  parseCampusFromAllSections,
  parseCatalogCourseCards,
  parseEnrollmentStatus,
  parseEnvList,
  parseGradingModeOptions,
  parseInstructorDetailHtml,
  parseInstructors,
  parseMeetingLocation,
  parseMeetingTimes,
  parseSeatsHtml,
  splitCourseCode,
  stripTags,
};
