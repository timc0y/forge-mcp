import os
import re

dirs = ['docs/research', 'docs/reviews', 'docs/handover']
lines_removed = 0
bytes_removed = 0

for d in dirs:
    if not os.path.exists(d):
        continue
    for f in os.listdir(d):
        if not f.endswith('.md'):
            continue
        path = os.path.join(d, f)
        with open(path, 'r') as file:
            content = file.read()
        
        orig_len = len(content)
        orig_lines = content.count('\n') + 1

        # Compression logic:
        # Remove empty lines
        new_content = re.sub(r'\n\s*\n', '\n', content)
        # Remove meta-commentary
        new_content = re.sub(r'(?i)In this document we will[^\n]*\n', '', new_content)
        new_content = re.sub(r'(?i)This document contains[^\n]*\n', '', new_content)
        new_content = re.sub(r'(?i)The purpose of this document is[^\n]*\n', '', new_content)
        
        new_len = len(new_content)
        new_lines = new_content.count('\n') + 1
        
        bytes_removed += (orig_len - new_len)
        lines_removed += (orig_lines - new_lines)

        with open(path, 'w') as file:
            file.write(new_content)

print(f"Removed {lines_removed} lines and {bytes_removed/1024:.2f} KB.")
