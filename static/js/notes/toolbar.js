import * as React from 'react';
import { createReactBlockSpec, createReactStyleSpec } from '@blocknote/react';
import { BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs, imageBlockConfig, imageParse } from '@blocknote/core';

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

function LazyImagePreview({ url, alt, width }) {
    const containerRef = React.useRef(null);
    const [shouldLoad, setShouldLoad] = React.useState(false);

    React.useEffect(() => {
        const element = containerRef.current;
        if (!element || shouldLoad) return undefined;
        if (typeof IntersectionObserver === 'undefined') {
            setShouldLoad(true);
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
            setShouldLoad(true);
            observer.disconnect();
        }, {
            root: document.getElementById('editor-page') || null,
            rootMargin: '900px 0px',
            threshold: 0.01,
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [shouldLoad]);

    return React.createElement(
        'div',
        {
            ref: containerRef,
            className: `bn-visual-media-wrapper notes-lazy-image-frame${shouldLoad ? ' is-loaded' : ''}`,
            style: { maxWidth: `${Math.max(96, Number(width || 512))}px` },
        },
        shouldLoad
            ? React.createElement('img', {
                className: 'bn-visual-media notes-lazy-image',
                src: url,
                alt,
                contentEditable: 'false',
                draggable: 'false',
                loading: 'lazy',
                decoding: 'async',
                fetchPriority: 'low',
            })
            : React.createElement(
                'div',
                {
                    className: 'notes-lazy-image-placeholder',
                    contentEditable: 'false',
                    'aria-label': alt,
                },
                React.createElement('span', {
                    className: 'material-symbols-outlined',
                    'aria-hidden': 'true',
                }, 'image'),
                React.createElement('span', null, alt || 'Image')
            )
    );
}

function LazyImageBlock(props) {
    const { url, caption, name, showPreview, previewWidth } = props.block.props;
    const label = name || caption || url || 'Image';
    if (!url) {
        return React.createElement(
            'div',
            { className: 'bn-file-block-content-wrapper' },
            React.createElement(
                'div',
                { className: 'bn-add-file-button', contentEditable: 'false' },
                React.createElement(
                    'div',
                    { className: 'bn-add-file-button-icon' },
                    React.createElement('span', { className: 'material-symbols-outlined', 'aria-hidden': 'true' }, 'image')
                ),
                React.createElement('p', { className: 'bn-add-file-button-text' }, 'Add image')
            )
        );
    }

    if (!showPreview) {
        return React.createElement(
            'div',
            { className: 'bn-file-block-content-wrapper' },
            React.createElement(
                'a',
                {
                    className: 'bn-file-name-with-icon notes-image-link-block',
                    href: url,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    contentEditable: 'false',
                    draggable: 'false',
                },
                React.createElement(
                    'div',
                    { className: 'bn-file-icon' },
                    React.createElement('span', { className: 'material-symbols-outlined', 'aria-hidden': 'true' }, 'image')
                ),
                React.createElement('p', { className: 'bn-file-name' }, label)
            ),
            caption ? React.createElement('p', { className: 'bn-file-caption' }, caption) : null
        );
    }

    return React.createElement(
        'div',
        { className: 'bn-file-block-content-wrapper' },
        React.createElement(LazyImagePreview, { url, alt: label, width: previewWidth }),
        caption ? React.createElement('p', { className: 'bn-file-caption' }, caption) : null
    );
}

function LazyImageToExternalHTML(props) {
    const { url, caption, name, showPreview, previewWidth } = props.block.props;
    const label = name || caption || url || 'BlockNote image';
    const media = showPreview
        ? React.createElement('img', {
            src: url,
            alt: label,
            width: previewWidth,
            loading: 'lazy',
            decoding: 'async',
            fetchPriority: 'low',
        })
        : React.createElement('a', { href: url }, name || url || 'Image');

    if (!url) return React.createElement('p', null, 'Add image');
    if (!caption) return media;
    return React.createElement('figure', null, media, React.createElement('figcaption', null, caption));
}

const lazyImageBlock = createReactBlockSpec(imageBlockConfig, {
    render: LazyImageBlock,
    parse: imageParse,
    toExternalHTML: LazyImageToExternalHTML,
});

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
        image: lazyImageBlock,
        divider: dividerBlock,
        callout: calloutBlock,
        bookmark: bookmarkBlock,
    },
    styleSpecs: {
        ...defaultStyleSpecs,
        fontSize: fontSizeStyle,
    },
});
