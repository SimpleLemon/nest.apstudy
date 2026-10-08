function createCourseActions({
  state, applySavedCourse, clearDetailReturnContext, fetchJson, getSection,
  rememberSection, render, renderPanel, showToast,
}) {
  async function addCourse(sectionId) {
    if (!sectionId || state.savedCoursesBySection.has(sectionId)) return;
    state.savingIds.add(sectionId);
    render();
    try {
      const payload = await fetchJson("/api/courses/saved", {
        method: "POST",
        body: JSON.stringify({ section_id: sectionId }),
      });
      if (payload.course?.section_id) {
        applySavedCourse(payload.course);
        state.removedSelectedSections.delete(String(payload.course.section_id));
      }
      showToast("Class added.");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Try again in a moment.", true, { title: "Couldn’t add class" });
    } finally {
      state.savingIds.delete(sectionId);
      render();
    }
  }

  async function removeCourse(courseId, sectionId) {
    if (!courseId) return;
    const accepted = await (window.APStudyConfirm?.request?.({
      title: "Remove class?",
      message: "This class will be removed from your weekly view.",
      acceptLabel: "Remove class",
      danger: true,
    }) ?? Promise.resolve(false));
    if (!accepted) return;
    if (sectionId) state.savingIds.add(sectionId);
    const savedCourse = sectionId ? state.savedCoursesBySection.get(String(sectionId)) : null;
    const removedSection = sectionId ? getSection(sectionId) : null;
    const previousDetailSectionId = state.detailSectionId;
    const previousEditingSectionId = state.editingSectionId;
    const restoresRemovedDetail = state.detailSectionId === sectionId || state.editingSectionId === sectionId;
    const previousDetailReturnContext = restoresRemovedDetail && state.detailReturnContext?.sectionId === String(sectionId)
      ? state.detailReturnContext
      : null;
    if (sectionId) state.savedCoursesBySection.delete(String(sectionId));
    if (sectionId && state.activeCourseView === "selected" && removedSection) {
      state.removedSelectedSections.set(String(sectionId), { ...removedSection, id: String(sectionId) });
    }
    if (restoresRemovedDetail) clearDetailReturnContext();
    if (state.detailSectionId === sectionId) state.detailSectionId = null;
    if (state.editingSectionId === sectionId) state.editingSectionId = null;
    render();
    window.APStudyUndo?.stage?.({
      message: `${removedSection?.course_code || removedSection?.course_title || "Class"} removed.`,
      commit: ({ reason }) => fetchJson(`/api/courses/saved/${encodeURIComponent(courseId)}`, {
        method: "DELETE",
        keepalive: reason === "pagehide",
      }),
      restore: () => {
        if (sectionId && savedCourse) state.savedCoursesBySection.set(String(sectionId), savedCourse);
        if (sectionId) state.removedSelectedSections.delete(String(sectionId));
        state.detailSectionId = previousDetailSectionId;
        state.editingSectionId = previousEditingSectionId;
        state.detailReturnContext = restoresRemovedDetail && previousDetailReturnContext?.sectionId === String(sectionId)
          ? previousDetailReturnContext
          : null;
        if (sectionId) state.savingIds.delete(sectionId);
        render();
      },
      onCommit: () => {
        if (sectionId) state.savingIds.delete(sectionId);
        render();
      },
      errorTitle: "Couldn’t remove class",
    });
    if (!window.APStudyUndo?.stage) {
      try {
        await fetchJson(`/api/courses/saved/${encodeURIComponent(courseId)}`, { method: "DELETE" });
      } catch (error) {
        if (sectionId && savedCourse) state.savedCoursesBySection.set(String(sectionId), savedCourse);
        showToast(error.message || "Try again in a moment.", true, { title: "Couldn’t remove class" });
      } finally {
        if (sectionId) state.savingIds.delete(sectionId);
        render();
      }
    }
  }

  async function setTrack(sectionId, enabled, intervalMinutes = null) {
    if (!sectionId) return;
    const wasEnabled = Boolean(state.tracksBySection.get(String(sectionId))?.enabled);
    state.trackingIds.add(sectionId);
    renderPanel();
    try {
      const payload = await fetchJson("/api/courses/tracks", {
        method: "POST",
        body: JSON.stringify({
          section_id: sectionId,
          enabled,
          ...(intervalMinutes ? { interval_minutes: Number(intervalMinutes) } : {}),
        }),
      });
      if (payload.section) rememberSection(payload.section);
      if (payload.track?.section_id) {
        state.tracksBySection.set(String(payload.track.section_id), payload.track);
        if (payload.track.term_policy) state.trackingTermPolicies[payload.track.term] = payload.track.term_policy;
      }
      if (enabled !== wasEnabled) state.trackingUsage = Math.max(0, state.trackingUsage + (enabled ? 1 : -1));
      const queued = enabled && payload.track?.tracking_state === "queued";
      showToast(!enabled ? "Tracking turned off." : queued ? "Tracker queued. Checks begin when this term opens." : intervalMinutes ? `Checking every ${Number(intervalMinutes)} minutes.` : "Tracking enabled.");
      if (enabled && !wasEnabled) window.dispatchEvent(new CustomEvent('apstudy:notification-intent', { detail: { source: 'course-tracking' } }));
    } catch (error) {
      console.error(error);
      const limitReached = error?.code === "tier_limit";
      showToast(
        error.message || "Try again in a moment.",
        true,
        { title: limitReached ? "Tracking limit reached" : "Couldn’t update tracking" },
      );
    } finally {
      state.trackingIds.delete(sectionId);
      render();
    }
  }

  async function removeTrack(trackId, sectionId) {
    if (!trackId || !sectionId) return;
    const track = state.tracksBySection.get(String(sectionId));
    const wasEnabled = Boolean(track?.enabled);
    const previousUsage = state.trackingUsage;
    state.trackingIds.add(sectionId);
    state.tracksBySection.delete(String(sectionId));
    if (wasEnabled) state.trackingUsage = Math.max(0, state.trackingUsage - 1);
    renderPanel();
    window.APStudyUndo?.stage?.({
      message: "Course tracker removed.",
      commit: ({ reason }) => fetchJson(`/api/courses/tracks/${encodeURIComponent(trackId)}`, {
        method: "DELETE",
        keepalive: reason === "pagehide",
      }),
      restore: () => {
        if (track) state.tracksBySection.set(String(sectionId), track);
        state.trackingUsage = previousUsage;
        state.trackingIds.delete(sectionId);
        render();
      },
      onCommit: () => {
        state.trackingIds.delete(sectionId);
        render();
      },
      errorTitle: "Couldn’t remove tracker",
    });
    if (!window.APStudyUndo?.stage) {
      try {
        await fetchJson(`/api/courses/tracks/${encodeURIComponent(trackId)}`, { method: "DELETE" });
      } catch (error) {
        if (track) state.tracksBySection.set(String(sectionId), track);
        state.trackingUsage = previousUsage;
        showToast(error.message || "Try again in a moment.", true, { title: "Couldn’t remove tracker" });
      } finally {
        state.trackingIds.delete(sectionId);
        render();
      }
    }
  }

  return { addCourse, removeCourse, setTrack, removeTrack };
}

export { createCourseActions };
