import { escapeHtml, formatBytes, formatCount } from './utils.js';
export function createSettingsSummary(state) {
  const elements = {
    storageUsed: Array.from(document.querySelectorAll('[data-storage-used]')),
    storageDetails: Array.from(document.querySelectorAll('[data-storage-details]')),
    connectedServices: document.getElementById('settings-connected-services'),
    previewTierBadge: document.getElementById('settings-preview-tier-badge'),
    previewTierBadgeTrigger: document.getElementById('settings-preview-tier-badge-trigger'),
    sectionsWrap: document.querySelector('.settings-sections'),
    skeleton: document.getElementById('settings-skeleton'),
    tierBadge: document.getElementById('settings-tier-badge'),
    tierBadgeTrigger: document.getElementById('settings-tier-badge-trigger'),
    tierLabel: document.querySelector('[data-tier-label]'),
    tierLimits: Array.from(document.querySelectorAll('[data-tier-limit]')),
    tierStatus: document.querySelector('[data-tier-status]'),
    tierStorage: document.querySelector('[data-tier-storage]'),
    tierStoragePercent: document.querySelector('[data-tier-storage-percent]'),
    tierStorageProgress: document.querySelector('[data-tier-storage-progress]'),
    tierStorageProgressTrack: document.querySelector('.settings-tier-progress[role="progressbar"]'),
    tierWarning: document.querySelector('[data-tier-warning]'),
  };
  function renderSettingsSkeleton() {
    elements.sectionsWrap?.classList.add('is-loading');
    elements.sectionsWrap?.setAttribute('aria-busy', 'true');
    if (!elements.skeleton) {
      return;
    }
    elements.skeleton.hidden = false;
  }

  function clearSettingsSkeleton() {
    elements.sectionsWrap?.classList.remove('is-loading');
    elements.sectionsWrap?.setAttribute('aria-busy', 'false');
    if (!elements.skeleton) {
      return;
    }
    elements.skeleton.hidden = true;
  }

  function renderEntitlements() {
    const data = state.entitlements;
    if (!data) return;
    const usage = data.usage || {};
    const limits = data.limits || {};
    const label = data.label || 'Free';
    if (elements.tierLabel) elements.tierLabel.textContent = label;

    const badgeNodes = [
      { image: elements.tierBadge, trigger: elements.tierBadgeTrigger },
      { image: elements.previewTierBadge, trigger: elements.previewTierBadgeTrigger },
    ].filter(({ image }) => image);
    badgeNodes.forEach(({ image, trigger }) => {
      const badge = data.badge;
      if (!badge) {
        image.hidden = true;
        if (trigger) trigger.hidden = true;
        return;
      }
      image.src = badge.asset;
      image.alt = '';
      image.hidden = false;
      if (trigger) {
        trigger.dataset.tooltip = label;
        trigger.setAttribute('aria-label', label);
        trigger.hidden = false;
      }
    });

    const used = Number(data.storage_usage_bytes || 0);
    const cap = data.storage_limit_bytes;
    const hasStorageCap = cap != null;
    const rawPercent = !hasStorageCap ? null : cap === 0 ? (used > 0 ? Infinity : 0) : (used / cap) * 100;
    const percent = rawPercent == null ? 0 : Math.min(100, rawPercent);
    if (elements.tierStorage) {
      elements.tierStorage.textContent = !hasStorageCap
        ? `${formatBytes(used)} used / Unlimited storage`
        : `${formatBytes(used)} used / ${formatBytes(cap)} (${Math.max(0, 100 - percent).toFixed(1)}% remaining)`;
    }
    if (elements.tierStoragePercent) {
      elements.tierStoragePercent.textContent = !hasStorageCap
        ? 'Unlimited'
        : rawPercent > 100 ? 'Over limit' : `${rawPercent.toFixed(0)}% used`;
    }
    if (elements.tierStorageProgress) elements.tierStorageProgress.style.transform = `scaleX(${percent / 100})`;
    const overLimit = Boolean(data.over_limit && Object.values(data.over_limit).some(Boolean)) || (hasStorageCap && used > cap);
    if (elements.tierStorageProgressTrack) {
      elements.tierStorageProgressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
      elements.tierStorageProgressTrack.setAttribute('aria-valuetext', !hasStorageCap ? `${formatBytes(used)} used, unlimited storage` : rawPercent === Infinity ? 'Storage limit reached' : `${rawPercent.toFixed(1)} percent used`);
      elements.tierStorageProgressTrack.classList.toggle('is-over-limit', overLimit);
    }
    if (elements.tierStatus) {
      elements.tierStatus.textContent = overLimit ? 'Needs attention' : 'Active';
      elements.tierStatus.classList.toggle('is-warning', overLimit);
    }
    if (elements.tierWarning) {
      elements.tierWarning.hidden = !overLimit;
      elements.tierWarning.textContent = overLimit ? 'You are over a current limit. Delete existing data before adding more.' : '';
    }

    const usageByLimit = {
      storage_bytes: limits.storage_bytes,
      max_file_size_bytes: limits.max_file_size_bytes,
      max_upload_files: limits.max_upload_files,
      max_notes: limits.max_notes,
      max_saved_courses: limits.max_saved_courses,
      max_seat_tracks: limits.max_seat_tracks,
      max_calendar_feeds: limits.max_calendar_feeds,
    };
    const usageByResource = {
      max_upload_files: 'files',
      max_notes: 'notes',
      max_saved_courses: 'saved_courses',
      max_seat_tracks: 'seat_tracks',
      max_calendar_feeds: 'calendar_feeds',
    };
    elements.tierLimits.forEach((node) => {
      const key = node.dataset.tierLimit;
      const limit = usageByLimit[key];
      if (key === 'storage_bytes' || key === 'max_file_size_bytes') {
        node.textContent = limit == null ? 'Unlimited' : formatBytes(limit);
        return;
      }
      node.textContent = limit == null ? 'Unlimited' : `${usage[usageByResource[key]] || 0} / ${limit}`;
    });
  }

  function renderConnectedServices() {
    if (!elements.connectedServices) {
      return;
    }
    if (!state.connectedServices.length) {
      elements.connectedServices.innerHTML = '<div class="settings-empty-state">No connected services.</div>';
      return;
    }

    elements.connectedServices.innerHTML = state.connectedServices.map((service) => {
      const label = escapeHtml(service.name || 'Connected service');
      const detail = escapeHtml(service.detail || service.description || 'Connected');
      return `<div class="settings-empty-state settings-connected-item"><strong>${label}</strong><p>${detail}</p></div>`;
    }).join('');
  }

    function renderStorageUsage() {
      elements.storageUsed?.forEach((node) => { node.textContent = formatBytes(state.storageUsageBytes); });
      elements.storageDetails?.forEach((node) => { node.textContent = `${formatCount(state.notesCount, 'note')}, ${formatCount(state.filesCount, 'file')}`; });
    }
  return { renderSettingsSkeleton, clearSettingsSkeleton, renderEntitlements, renderConnectedServices, renderStorageUsage };
}
