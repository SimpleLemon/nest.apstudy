import * as React from 'react';
import { createReactBlockSpec, createReactStyleSpec } from '@blocknote/react';
import { BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs } from '@blocknote/core';

const indentLevelProp = {
    default: 0,
    values: [0, 1, 2, 3, 4],
};

const collapsedProp = {
    default: false,
};

function extendBlockProps(blockSpec, extraProps) {
    return {
        ...blockSpec,
        config: {
            ...blockSpec.config,
            propSchema: {
                ...blockSpec.config.propSchema,
                ...extraProps,
            },
        },
    };
}

const fontSizeStyle = createReactStyleSpec(
    {
        type: 'fontSize',
        propSchema: 'string',
    },
    {
        render: (props) => React.createElement('span', {
            ref: props.contentRef,
            style: { fontSize: props.value },
        }),
    }
);

const dividerBlock = createReactBlockSpec(
    {
        type: 'divider',
        propSchema: {},
        content: 'none',
    },
    {
        render: () => React.createElement('hr', { className: 'notes-divider-block' }),
        toExternalHTML: () => React.createElement('hr', null),
        parse: (element) => {
            if (element.tagName === 'HR') return {};
            if (element.dataset?.contentType === 'divider' || element.dataset?.contentType === 'horizontalRule') return {};
            return undefined;
        },
    }
);

const calloutBlock = createReactBlockSpec(
    {
        type: 'callout',
        propSchema: {
            tone: {
                default: 'info',
                values: ['info', 'note', 'success', 'warning', 'danger'],
            },
            icon: {
                default: 'lightbulb',
            },
        },
        content: 'inline',
    },
    {
        render: (props) => React.createElement(
            'div',
            {
                className: `notes-callout-block notes-callout-${props.block.props.tone || 'info'}`,
            },
            React.createElement('span', {
                className: 'material-symbols-outlined notes-callout-icon',
                'aria-hidden': 'true',
            }, props.block.props.icon || 'lightbulb'),
            React.createElement('div', {
                ref: props.contentRef,
                className: 'notes-callout-content',
            })
        ),
        toExternalHTML: (props) => React.createElement(
            'aside',
            {
                className: `notes-callout-block notes-callout-${props.block.props.tone || 'info'}`,
                'data-callout-tone': props.block.props.tone || 'info',
            },
            React.createElement('strong', null, 'Callout'),
            React.createElement('div', { ref: props.contentRef })
        ),
        parse: (element) => {
            if (element.dataset?.contentType !== 'callout' && !element.classList?.contains('notes-callout-block')) {
                return undefined;
            }
            return {
                tone: element.dataset?.calloutTone || element.dataset?.tone || 'info',
                icon: element.dataset?.icon || 'lightbulb',
            };
        },
    }
);

const bookmarkBlock = createReactBlockSpec(
    {
        type: 'bookmark',
        propSchema: {
            url: { default: '' },
            title: { default: '' },
            description: { default: '' },
            imageUrl: { default: '' },
            siteName: { default: '' },
            faviconUrl: { default: '' },
            contentType: { default: '' },
        },
        content: 'none',
    },
    {
        render: (props) => {
            const { url, title, description, imageUrl, siteName } = props.block.props;
            const displayTitle = title || url || 'Untitled bookmark';
            let hostname = siteName;
            if (!hostname && url) {
                try {
                    hostname = new URL(url).hostname;
                } catch (error) {
                    hostname = '';
                }
            }
            return React.createElement(
                'a',
                {
                    className: 'notes-bookmark-block',
                    href: url || '#',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    contentEditable: 'false',
                    draggable: 'false',
                },
                imageUrl
                    ? React.createElement('span', {
                        className: 'notes-bookmark-image',
                        style: { backgroundImage: `url("${String(imageUrl).replaceAll('"', '%22')}")` },
                        'aria-hidden': 'true',
                    })
                    : React.createElement('span', {
                        className: 'notes-bookmark-image notes-bookmark-image-empty',
                        'aria-hidden': 'true',
                    }, React.createElement('span', {
                        className: 'material-symbols-outlined',
                    }, 'bookmarks')),
                React.createElement(
                    'span',
                    { className: 'notes-bookmark-body' },
                    React.createElement('strong', { className: 'notes-bookmark-title' }, displayTitle),
                    description
                        ? React.createElement('span', { className: 'notes-bookmark-description' }, description)
                        : null,
                    React.createElement('span', { className: 'notes-bookmark-url' }, hostname || url)
                )
            );
        },
        toExternalHTML: (props) => React.createElement(
            'a',
            {
                href: props.block.props.url || '#',
                rel: 'noopener noreferrer nofollow',
            },
            props.block.props.title || props.block.props.url || 'Bookmark'
        ),
        parse: (element) => {
            if (element.dataset?.contentType !== 'bookmark' && !element.classList?.contains('notes-bookmark-block')) {
                return undefined;
            }
            return {
                url: element.getAttribute('href') || element.dataset?.url || '',
                title: element.dataset?.title || element.textContent?.trim() || '',
                description: element.dataset?.description || '',
                imageUrl: element.dataset?.imageUrl || '',
                siteName: element.dataset?.siteName || '',
                faviconUrl: element.dataset?.faviconUrl || '',
                contentType: element.dataset?.contentTypeValue || '',
            };
        },
    }
);

export const notesEditorSchema = BlockNoteSchema.create({
    blockSpecs: {
        ...defaultBlockSpecs,
        paragraph: extendBlockProps(defaultBlockSpecs.paragraph, { indentLevel: indentLevelProp }),
        heading: extendBlockProps(defaultBlockSpecs.heading, {
            indentLevel: indentLevelProp,
            isCollapsed: collapsedProp,
        }),
        divider: dividerBlock,
        callout: calloutBlock,
        bookmark: bookmarkBlock,
    },
    styleSpecs: {
        ...defaultStyleSpecs,
        fontSize: fontSizeStyle,
    },
});
