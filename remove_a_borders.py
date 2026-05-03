import os
import re

def clean_class_string(cls_str):
    classes = cls_str.split()
    new_classes = []
    for c in classes:
        if c.startswith('border-') and c not in ['border-transparent', 'border-0', 'border-none', 'border-2', 'border-4', 'border-8']:
            continue
        if c == 'border':
            continue
        if 'border-' in c and ':' in c:
            if 'border-transparent' in c or 'border-0' in c or 'border-none' in c:
                new_classes.append(c)
            continue
        new_classes.append(c)
    return ' '.join(new_classes)

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    def a_replacer(match):
        a_tag = match.group(0)
        class_match = re.search(r'class="([^"]+)"', a_tag)
        if class_match:
            old_classes = class_match.group(1)
            # only process if it seems like a button (has padding, rounded, etc)
            if 'px-' in old_classes and 'py-' in old_classes:
                new_classes = clean_class_string(old_classes)
                return a_tag.replace(f'class="{old_classes}"', f'class="{new_classes}"')
        return a_tag

    new_content = re.sub(r'<a\s+[^>]+>', a_replacer, content)

    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk('templates'):
    for file in files:
        if file.endswith('.html'):
            process_file(os.path.join(root, file))

