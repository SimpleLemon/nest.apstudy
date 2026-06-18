(function () {
  const ATLAS_BASE_URL = "https://atlas.emory.edu/api/";
  const CACHE_TTL_MS = 2 * 60 * 1000;
  const memoryCache = new Map();
  let browserDirectBlocked = window.APSTUDY_ATLAS_BROWSER_DIRECT_ENABLED !== true;
  const dayMap = {
    "0": "Mon",
    "1": "Tue",
    "2": "Wed",
    "3": "Thu",
    "4": "Fri",
    "5": "Sat",
    "6": "Sun",
  };
  const statusMap = { O: "Open", C: "Closed", W: "Waitlist" };

  function cacheKey(term, subject, campus) {
    return `apstudy:atlas-live:${term}:${String(subject || "").toUpperCase()}:${String(campus || "all").toLowerCase()}`;
  }

  function getCached(key) {
    const memory = memoryCache.get(key);
    const now = Date.now();
    if (memory && now - memory.ts < CACHE_TTL_MS) return memory.data;
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null");
      if (stored && now - stored.ts < CACHE_TTL_MS) {
        memoryCache.set(key, stored);
        return stored.data;
      }
    } catch (error) {
      sessionStorage.removeItem(key);
    }
    return null;
  }

  function setCached(key, data) {
    const entry = { ts: Date.now(), data };
    memoryCache.set(key, entry);
    try {
      sessionStorage.setItem(key, JSON.stringify(entry));
    } catch (error) {
      // Storage quota or privacy mode should not block live refresh.
    }
  }

  async function fetchSubjectSections(term, subject, options = {}) {
    if (browserDirectBlocked) {
      throw new Error("Atlas blocks browser live requests from this site. Showing local data.");
    }
    const srcdb = window.APSTUDY_ATLAS_SRCDB?.[term];
    const normalizedSubject = String(subject || "").trim().toUpperCase();
    const campus = normalizeCampusFilter(options.campus);
    if (!srcdb) throw new Error("Atlas term mapping unavailable.");
    if (!normalizedSubject) throw new Error("Missing Atlas subject.");

    const key = cacheKey(term, normalizedSubject, campus);
    const cached = getCached(key);
    if (cached) return cached;

    const url = new URL(ATLAS_BASE_URL);
    url.searchParams.set("page", "fose");
    url.searchParams.set("route", "search");

    const criteria = [{ field: "subject", value: normalizedSubject }];
    if (campus) criteria.push({ field: "campus", value: campus });

    let response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          other: { srcdb },
          criteria,
        }),
      });
    } catch (error) {
      browserDirectBlocked = true;
      throw new Error("Atlas blocks browser live requests from this site. Showing local data.");
    }
    if (!response.ok) throw new Error(`Atlas live request failed (${response.status}).`);

    const payload = await response.json();
    if (!payload || payload.fatal) throw new Error(payload?.fatal || "Atlas returned no live data.");
    const sections = Array.isArray(payload.results)
      ? payload.results.map((raw) => normalizeRawSection(term, raw)).filter((row) => row.subject === normalizedSubject)
      : [];
    setCached(key, sections);
    return sections;
  }

  async function fetchSectionDetails(term, atlasKey) {
    const srcdb = window.APSTUDY_ATLAS_SRCDB?.[term];
    if (!srcdb || !atlasKey) return null;
    const url = new URL(ATLAS_BASE_URL);
    url.searchParams.set("page", "fose");
    url.searchParams.set("route", "details");
    const response = await fetch(url.toString(), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ other: { srcdb }, group: `key:${atlasKey}` }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || payload.fatal) return null;
    return payload;
  }

  async function fetchSectionStatus(section) {
    const local = section || {};
    const atlasKey = String(local.atlas_key || local.key || "").trim();
    if (atlasKey && !browserDirectBlocked) {
      try {
        const details = await fetchSectionDetails(local.term, atlasKey);
        if (details) {
          const searchRow = {
            code: local.course_code,
            crn: local.crn,
            no: local.section_number,
            enrl_stat: local.enrollment_status,
            meetingTimes: local.meetings,
            meets: local.schedule_display,
          };
          return normalizeRawSection(local.term, applyDetailsToRow(searchRow, details));
        }
      } catch (error) {
        // Fall back to subject search below.
      }
    }
    const sections = await fetchSubjectSections(local.term, local.subject, { campus: local.campus || local.campus_description });
    const catalog = String(local.catalog_number || local.catalog || "").toUpperCase();
    const crn = String(local.crn || "");
    const sectionNumber = String(local.section_number || "");
    const matched = sections.find((row) => {
      if (String(row.catalog_number || "").toUpperCase() !== catalog) return false;
      const crnMatches = !crn || String(row.crn || "") === crn;
      const sectionMatches = !sectionNumber || String(row.section_number || "") === sectionNumber;
      return crnMatches && sectionMatches;
    });
    if (!matched) throw new Error("Atlas live section not found.");
    return matched;
  }

  function stripTags(html) {
    return String(html ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
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

  function cellValue(html) {
    return stripTags(html).replace(/^[^:]+:\s*/, "").trim();
  }

  function parseCampusFromAllSections(html, crn, sectionNumber) {
    const source = String(html ?? "");
    const rows = source.match(/<a[^>]*class="course-section"[^>]*>([\s\S]*?)<\/a>/gi) || [];
    for (const rowHtml of rows) {
      const rowCrn = cellValue((/course-section-crn[^>]*>([\s\S]*?)<\/div>/i.exec(rowHtml) || [])[1] || "");
      const rowSection = cellValue((/course-section-section[^>]*>([\s\S]*?)<\/div>/i.exec(rowHtml) || [])[1] || "");
      if (crn && rowCrn !== String(crn)) continue;
      if (!crn && sectionNumber && rowSection !== String(sectionNumber)) continue;
      return cellValue((/course-section-camp[^>]*>([\s\S]*?)<\/div>/i.exec(rowHtml) || [])[1] || "") || null;
    }
    return null;
  }

  function applyDetailsToRow(searchRow, details) {
    const crn = String(details.crn || searchRow.crn || "").trim();
    const sectionNumber = String(details.section || searchRow.no || "").trim();
    const seats = parseSeatsHtml(details.seats);
    const campusDescription = parseCampusFromAllSections(details.all_sections, crn, sectionNumber);
    const requirementDesignation = stripTags(details.clss_assoc_rqmnt_designt_html) || null;
    const locationMatch = /\bin\s+<a[^>]*>([^<]+)<\/a>/i.exec(String(details.meeting_html || ""))
      || /\bin\s+([^<]+?)(?:<\/span>|$)/i.exec(String(details.meeting_html || ""));
    return {
      ...searchRow,
      key: details.key || searchRow.key,
      atlas_key: details.key || searchRow.key,
      code: details.code || searchRow.code,
      title: details.title || searchRow.title,
      crn,
      no: sectionNumber,
      credit_hours: details.credit_hours_options || stripTags(details.hours_html),
      enrollment_capacity: seats.enrollment_capacity,
      seats_available: seats.seats_available,
      waitlist_total: seats.waitlist_total,
      waitlist_capacity: seats.waitlist_capacity,
      grading_mode: details.grademode_code || null,
      grading_mode_options: String(details.gmods || "").split(",").map((item) => item.trim()).filter(Boolean),
      instruction_method: details.inst_method_code || null,
      enrl_stat: stripTags(details.enrl_stat_html) || searchRow.enrl_stat,
      requirement_designation: requirementDesignation,
      requirements: requirementDesignation ? [requirementDesignation] : [],
      campus_description: campusDescription,
      location: locationMatch ? stripTags(locationMatch[1]) : null,
      course_description: stripTags(details.description) || null,
      course_notes: stripTags(details.clssnotes) || null,
      meeting_html: details.meeting_html,
      meets: stripTags(details.meeting_html) || searchRow.meets,
    };
  }

  function normalizeRawSection(term, raw) {
    const courseCode = String(raw?.code || raw?.course_code || "").trim();
    const { subject, catalog } = splitCourseCode(courseCode);
    const crn = String(raw?.crn || "").trim();
    const sectionNumber = String(raw?.no || raw?.section_number || "").trim();
    const status = normalizeEnrollmentStatus(raw?.enrl_stat || raw?.enrollment_status);
    const requirements = normalizeRequirements(raw);
    const campusDescription = firstPresent(raw, ["campus_description", "campus", "campusDescription", "campus_descr", "campusDescr"]);
    return {
      id: [term, subject, catalog, crn || "na", sectionNumber || "na"].join("|"),
      term,
      subject,
      catalog_number: catalog,
      catalog,
      course_code: courseCode,
      course_title: raw?.title || raw?.course_title || "",
      crn,
      section_number: sectionNumber,
      atlas_key: raw?.atlas_key || raw?.key || null,
      schedule_type: raw?.schd || raw?.schedule_type || "",
      instructor: raw?.instr || raw?.instructor || "TBA",
      instructors: normalizeInstructors(raw?.instructors || raw?.instr || raw?.instructor),
      location: firstPresent(raw, ["location", "loc", "room", "building", "bldg_room", "bldgRoom"]),
      campus: normalizeCampusValue(campusDescription, subject),
      campus_description: campusDescription,
      enrollment_status: normalizeEnrollmentStatus(raw?.enrl_stat || raw?.enrollment_status),
      enrollment_count: String(raw?.total || raw?.enrollment_count || ""),
      seats_available: firstInt(raw, ["seats_available", "seatsAvailable", "available_seats", "availableSeats", "seats_avail", "seatsAvail", "avail", "open_seats", "openSeats"]) ?? inferSeatsAvailable(status, raw),
      enrollment_capacity: firstInt(raw, ["enrollment_capacity", "capacity", "max_enrl", "maxEnrollment", "seats_capacity", "seatsCapacity"]),
      waitlist_total: firstInt(raw, ["waitlist_total"]),
      waitlist_capacity: firstInt(raw, ["waitlist_capacity"]),
      grading_mode: raw?.grading_mode || raw?.grademode_code || null,
      grading_mode_options: raw?.grading_mode_options || String(raw?.gmods || "").split(",").map((item) => item.trim()).filter(Boolean),
      instruction_method: raw?.instruction_method || raw?.inst_method_code || null,
      is_cancelled: Boolean(raw?.isCancelled || raw?.is_cancelled),
      schedule_display: raw?.meets || raw?.schedule_display || "TBA",
      meetings: parseMeetingTimes(raw?.meetingTimes || raw?.meetings),
      date_range: {
        start: raw?.start_date || raw?.startDate || null,
        end: raw?.end_date || raw?.endDate || null,
      },
      credit_hours: firstPresent(raw, ["credit_hours", "credits", "hours", "credit_hours_options"]),
      requirement_designation: requirements[0] || null,
      requirements,
      course_description: firstPresent(raw, ["course_description", "description", "catalog_description", "desc"]),
      course_notes: raw?.course_notes || raw?.notes || "",
      live: true,
    };
  }

  function splitCourseCode(code) {
    const parts = String(code || "").trim().split(/\s+/);
    if (parts.length < 2) return { subject: String(code || "").trim().toUpperCase(), catalog: "" };
    const catalog = parts.pop();
    return { subject: parts.join(" ").toUpperCase(), catalog };
  }

  function normalizeEnrollmentStatus(value) {
    const raw = String(value || "").trim();
    if (!raw) return "Unknown";
    return statusMap[raw.toUpperCase()] || (raw === raw.toLowerCase() ? raw.replace(/^\w/, (char) => char.toUpperCase()) : raw);
  }

  function normalizeInstructors(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "object" && item) {
          return { name: String(item.name || item.instructor || "").trim(), email: item.email || item.mail || null };
        }
        return { name: String(item || "").trim(), email: null };
      }).filter((item) => item.name && item.name !== "TBA");
    }
    return String(value).split(/\s*(?:;|, and | and )\s*/).map((name) => ({
      name: name.trim(),
      email: null,
    })).filter((item) => item.name && item.name !== "TBA");
  }

  function parseMeetingTimes(raw) {
    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((meeting) => meeting && typeof meeting === "object").map((meeting) => ({
      day: dayMap[String(meeting.meet_day)] || `Day${meeting.meet_day}`,
      start: String(meeting.start_time || ""),
      end: String(meeting.end_time || ""),
    }));
  }

  function inferSeatsAvailable(status, source) {
    const parsed = firstInt(source, [
      "seats_available",
      "seatsAvailable",
      "available_seats",
      "availableSeats",
      "seats_avail",
      "seatsAvail",
      "avail",
      "open_seats",
      "openSeats",
    ]);
    if (parsed !== null) return parsed;
    return String(status || "").toLowerCase() === "closed" ? 0 : null;
  }

  function firstPresent(source, keys) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== null && typeof value !== "undefined" && value !== "" && !(Array.isArray(value) && value.length === 0)) {
        return value;
      }
    }
    return null;
  }

  function firstInt(source, keys) {
    const value = firstPresent(source, keys);
    if (value === null) return null;
    const parsed = Number.parseInt(String(value).match(/-?\d+/)?.[0] || "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeCampusFilter(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw || raw === "all") return "";
    if (raw.includes("oxford")) return "Oxford";
    if (raw.includes("atlanta") || raw.includes("main") || raw === "emory") return "Atlanta";
    return value;
  }

  function normalizeCampusValue(value, subject) {
    const raw = String(value || "").trim();
    const lowered = raw.toLowerCase();
    if (lowered.includes("oxford") || lowered.startsWith("oxf@")) return "Oxford";
    if (lowered.includes("atlanta") || lowered.includes("main") || lowered === "emory" || lowered.startsWith("atl@")) {
      return "Atlanta";
    }
    const upperSubject = String(subject || "").toUpperCase();
    if (upperSubject.startsWith("OX") || upperSubject.endsWith("_OX")) return "Oxford";
    return raw || null;
  }

  function normalizeRequirements(raw) {
    const values = [];
    [
      "requirement_designation",
      "requirements",
      "requirement",
      "requirement_description",
      "requirement_descriptions",
      "ger",
      "ge_req",
      "geReq",
      "rqmt",
      "rqmt_descr",
      "attributes",
    ].forEach((key) => pushRequirement(values, raw?.[key]));
    return values;
  }

  function pushRequirement(values, value) {
    if (value === null || typeof value === "undefined" || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((item) => pushRequirement(values, item));
      return;
    }
    if (typeof value === "object") {
      ["name", "label", "description", "value", "text"].forEach((key) => pushRequirement(values, value[key]));
      return;
    }
    const text = String(value).trim();
    if (text && !values.includes(text)) values.push(text);
  }

  window.APStudyAtlasLive = {
    fetchSectionStatus,
    fetchSubjectSections,
    normalizeRawSection,
  };
})();
