import * as React from 'react';
import { createReactStyleSpec } from '@blocknote/react';
import { BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs } from '@blocknote/core';

const indentLevelProp = {
    default: 0,
    values: [0, 1, 2, 3, 4],
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

export const notesEditorSchema = BlockNoteSchema.create({
    blockSpecs: {
        ...defaultBlockSpecs,
        paragraph: extendBlockProps(defaultBlockSpecs.paragraph, { indentLevel: indentLevelProp }),
        heading: extendBlockProps(defaultBlockSpecs.heading, { indentLevel: indentLevelProp }),
    },
    styleSpecs: {
        ...defaultStyleSpecs,
        fontSize: fontSizeStyle,
    },
});
