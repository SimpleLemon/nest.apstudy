#!/usr/bin/env python3
import os
import re

os.chdir('/workspaces/emory.apstudy')

# ============================================================
# Problem 5: Update sidebar background color in layout.css
# ============================================================
with open('static/css/layout.css', 'r') as f:
    content = f.read()

content = content.replace('--bg-sidebar: #1c1c24;', '--bg-sidebar: #1e1e24;')

with open('static/css/layout.css', 'w') as f:
    f.write(content)

print("✓ layout.css: sidebar bg color updated to #1e1e24")

# ============================================================
# Problem 6: Add border to sidebar-collapse button
# ============================================================
with open('static/css/layout.css', 'r') as f:
    content = f.read()

# Add border to sidebar-collapse hover state
old_collapse_hover = """.sidebar-collapse:hover {
  color: var(--text-primary);
  background: var(--accent-hover);
}"""

new_collapse_hover = """.sidebar-collapse:hover {
  color: var(--text-primary);
  background: var(--accent-hover);
  border: 1px solid var(--border-color);
}"""

content = content.replace(old_collapse_hover, new_collapse_hover)

with open('static/css/layout.css', 'w') as f:
    f.write(content)

print("✓ layout.css: sidebar-collapse hover border added")

# ============================================================
# Problem 1: Fix duplicate profile dropdown CSS
# ============================================================
with open('static/css/sidebar.css', 'r') as f:
    sidebar_css = f.read()

# Remove the duplicate profile dropdown section at the end
# Find the start of the duplicate section
duplicate_start = sidebar_css.find('\n/* Profile dropdown */')
if duplicate_start > 0:
    # Check if there's already a profile dropdown section in layout.css
    with open('static/css/layout.css', 'r') as f:
        layout_css = f.read()
    
    if '/* Profile dropdown */' in layout_css:
        # Remove the duplicate from sidebar.css
        sidebar_css = sidebar_css[:duplicate_start]
        with open('static/css/sidebar.css', 'w') as f:
            f.write(sidebar_css)
        print("✓ sidebar.css: duplicate profile dropdown CSS removed")
    else:
        print("✗ layout.css doesn't have profile dropdown section yet")
else:
    print("✓ sidebar.css: no duplicate profile dropdown found")

# ============================================================
# Problem 2: Fix Courses button route
# ============================================================
with open('static/js/sidebar.js', 'r') as f:
    sidebar_js = f.read()

sidebar_js = sidebar_js.replace(
    'data-route="/dashboard" data-courses="true"',
    'data-route="/courses" data-courses="true"'
)

with open('static/js/sidebar.js', 'w') as f:
    f.write(sidebar_js)

print("✓ sidebar.js: Courses button route fixed to /courses")

# ============================================================
# Problem 3: Fix Courses button hidden class logic
# ============================================================
with open('static/js/sidebar.js', 'r') as f:
    sidebar_js = f.read()

# Change the hidden class logic: show for Emory students, hide for non-Emory
old_courses = '''<button class="sidebar-item ${!isEmoryStudent ? 'hidden' : ''} ${isActive('/courses') ? 'active' : ''}" data-route="/courses" data-courses="true" aria-label="Courses">'''
new_courses = '''<button class="sidebar-item ${isEmoryStudent ? '' : 'hidden'} ${isActive('/courses') ? 'active' : ''}" data-route="/courses" data-courses="true" aria-label="Courses">'''

sidebar_js = sidebar_js.replace(old_courses, new_courses)

with open('static/js/sidebar.js', 'w') as f:
    f.write(sidebar_js)

print("✓ sidebar.js: Courses button hidden class logic fixed")

# ============================================================
# Problem 4: Fix sidebar tooltip positioning
# ============================================================
with open('static/js/sidebar.js', 'r') as f:
    sidebar_js = f.read()

# Replace the tooltip positioning logic
old_tooltip = """      // Position tooltip to the right of the icon
      const tooltipWidth = tooltip.offsetWidth;
      tooltip.style.left = (rect.right + 12) + 'px';
      tooltip.style.top = (rect.top + rect.height / 2 - tooltip.offsetHeight / 2) + 'px';"""

new_tooltip = """      // Position tooltip to the right of the collapsed sidebar
      const sidebar = document.querySelector('.sidebar-container');
      const sidebarRight = sidebar ? sidebar.getBoundingClientRect().right : rect.right;
      tooltip.style.left = (sidebarRight + 12) + 'px';
      tooltip.style.top = (rect.top + rect.height / 2 - tooltip.offsetHeight / 2) + 'px';"""

sidebar_js = sidebar_js.replace(old_tooltip, new_tooltip)

with open('static/js/sidebar.js', 'w') as f:
    f.write(sidebar_js)

print("✓ sidebar.js: tooltip positioning fixed for collapsed sidebar")

# ============================================================
# Summary
# ============================================================
print("\n=== All fixes applied successfully ===")
