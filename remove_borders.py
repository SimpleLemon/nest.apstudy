import os
import re

def clean_class_string(cls_str):
    # Split classes, filter out border-related ones, except border-transparent and border-0
    classes = cls_str.split()
    new_classes = []
    for c in classes:
        if c.startswith('border-') and c not in ['border-transparent', 'border-0', 'border-none', 'border-2', 'border-4', 'border-8']:
            continue
        if c == 'border':
            continue
        if 'border-' in c and ':' in c: # e.g. aria-pressed:border-primary/70, hover:border-..., focus:border-...
            # Keep border-transparent variations if any, else remove
            if 'border-transparent' in c or 'border-0' in c or 'border-none' in c:
                new_classes.append(c)
            continue
        new_classes.append(c)
    return ' '.join(new_classes)

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Regex to find <button ... class="...">
    # We will use a function to replace only the class attribute inside <button> tags
    def button_replacer(match):
        button_tag = match.group(0)
        class_match = re.search(r'class="([^"]+)"', button_tag)
        if class_match:
            old_classes = class_match.group(1)
            new_classes = clean_class_string(old_classes)
            # To handle default borders, we ensure no border color is present. 
            # If we just remove 'border', it removes the border entirely (width 0).
            # This satisfies "no border color".
            # We don't need to add border-transparent if we remove 'border'.
            return button_tag.replace(f'class="{old_classes}"', f'class="{new_classes}"')
        return button_tag

    new_content = re.sub(r'<button[^>]+>', button_replacer, content)

    # Also handle the JS constants in onboarding.html
    if 'onboarding.html' in filepath:
        # segment option classes
        def const_replacer(m):
            const_name = m.group(1)
            old_classes = m.group(2)
            new_classes = clean_class_string(old_classes)
            return f"{const_name} = '{new_classes}';"
        
        new_content = re.sub(r"(const (?:SEGMENTED_OPTION_CLASSES|REMOVE_CALENDAR_BUTTON_CLASSES)) = '([^']+)';", const_replacer, new_content)

    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk('templates'):
    for file in files:
        if file.endswith('.html'):
            process_file(os.path.join(root, file))

# Wait, check for any buttons in JS files as well
for root, dirs, files in os.walk('static/js'):
    for file in files:
        if file.endswith('.js'):
            process_file(os.path.join(root, file))

