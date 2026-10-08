import { parseFragment } from 'parse5';
import { createSettingsDOM, SettingsElement } from './settings-dom.mjs';

// Use real HTML parsing for controls rendered by classic feature scripts.
export function createParsedDOM(url = 'https://nest.example/notes') {
    const { window } = createSettingsDOM(url);
    const document = window.document;
    document.body.replaceChildren();
    class ParsedElement extends SettingsElement {
        set innerHTML(value) {
            this.html = value;
            this.replaceChildren();
            const add = (parent, node) => {
                if (!node.tagName) return;
                const child = document.createElement(node.tagName);
                for (const { name, value } of node.attrs) child.setAttribute(name, value);
                child.hidden = child.attributes.has('hidden');
                child.value = child.getAttribute('value') || '';
                child.textContent = (node.childNodes || []).filter(node => node.nodeName === '#text').map(node => node.value).join('');
                parent.appendChild(child);
                for (const descendant of node.childNodes || []) add(child, descendant);
                if (node.tagName === 'select') {
                    const options = child.querySelectorAll('option');
                    child.value = (options.find(option => option.attributes.has('selected')) || options[0])?.value || '';
                }
            };
            for (const node of parseFragment(value).childNodes) add(this, node);
        }
        get innerHTML() { return super.innerHTML; }
        click() {
            if (!this.disabled) this.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
        }
    }
    document.createElement = tag => {
        const node = new ParsedElement(tag);
        node.ownerDocument = document;
        return node;
    };
    return { window, document };
}
