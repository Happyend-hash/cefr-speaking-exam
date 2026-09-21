/**
 * The official writing rating scale, verbatim.
 *
 * Source: the board's own "Rating scales" document. Three parts, each given ONE
 * holistic band — not a set of criterion scores. Every band carries its own
 * CEFR label, which is better than the speaking sheets, where the level had to
 * be inferred.
 *
 *   Part 1.1  informal email   0-5
 *   Part 1.2  formal email     0-5
 *   Part 2    blog / article   0-6
 *
 * HOLISTIC, NOT ANALYTIC. Each descriptor names six things — task fulfilment,
 * register, grammar, vocabulary, cohesion, spelling and punctuation — and the
 * rater weighs them into a single band. They are not scored separately and must
 * never be averaged: the reference material compiled from two CEFR specialists
 * lists grammar-focused scoring as the first of five rater mistakes, and
 * averaging six dimensions is how a marker arrives at it by accident.
 *
 * The text is the board's and is shown to students unchanged. Do not
 * paraphrase, do not translate, do not tidy: a student comparing our feedback
 * against the official scale must find the same sentence.
 */

/**
 * What each band means, in the scale's own labels.
 *
 * These carry the ceiling of each part. Part 1.1 tops out at "B2 or above" — a
 * 50-word informal email cannot establish more than that, and the board says so
 * by leaving the top open rather than naming a level. Part 2 is the only part
 * that reaches C1 and beyond.
 */
export const WRITING_PARTS = [
  {
    key: 'part11',
    name: 'Part 1.1',
    description: 'Informal email to a friend',
    max: 5,
    labels: {
      5: 'B2 or above',
      4: 'Higher B1',
      3: 'Lower B1',
      2: 'A2',
      1: 'A1 or lower',
      0: 'No attempt'
    },
    bands: {
      5: [
        'The response fulfils the communicative purpose clearly and effectively. It addresses the required content and develops the main ideas with relevant details.',
        'The informal register is consistently appropriate.',
        'A range of familiar and some more complex grammatical structures is used with generally good control; errors occur mainly in more ambitious language and do not affect communication.',
        'Vocabulary is sufficiently varied and precise for the task.',
        'Ideas are connected into a coherent message using a range of appropriate cohesive devices.',
        'Spelling and punctuation are consistently accurate apart from occasional minor slips.'
      ],
      4: [
        'The response fulfils the communicative purpose and is generally clear. It addresses most or all of the required content and provides some relevant development.',
        'The informal register is generally appropriate, although occasional shifts in tone may occur.',
        'A range of familiar grammatical structures is used with good control; errors occur when attempting less familiar or more complex structures but do not normally affect communication.',
        'Vocabulary is sufficient for the task, with some ability to express ideas beyond basic statements.',
        'Ideas are connected into a reasonably coherent message using simple but effective cohesive devices.',
        'Spelling and punctuation are generally accurate.'
      ],
      3: [
        'The response conveys the main message but fulfils the communicative purpose only partly. It addresses some of the required content, though ideas may be brief, insufficiently developed or occasionally unclear.',
        'The informal register is generally understandable but may not be maintained consistently.',
        'Simple grammatical structures are generally controlled, while attempts at more complex structures contain noticeable errors.',
        'Vocabulary is sufficient for basic communication but may be repetitive or imprecise.',
        'Ideas are linked mainly through simple cohesive devices and may follow a straightforward sequence.',
        'Spelling and punctuation are generally understandable despite noticeable errors.'
      ],
      2: [
        'The response communicates some basic information but provides limited evidence of B1-level writing. It addresses at least part of the required content, although important information may be missing or unclear.',
        'Awareness of the informal register may be limited.',
        'It uses mainly simple sentence structures, with frequent errors that sometimes affect communication.',
        'Vocabulary is limited and may be repetitive or inappropriate for parts of the task.',
        'The response may consist largely of separate sentences with limited connection between ideas.',
        'Spelling and punctuation errors are noticeable and may occasionally affect readability.'
      ],
      1: [
        'The response provides very limited evidence of the ability to complete the task. It contains isolated words, phrases or very simple sentences, with little meaningful development of the required content.',
        'Grammatical and lexical limitations frequently impede communication.',
        'There is little evidence of coherent organisation or awareness of the intended reader and register.',
        'The response may contain substantial use of L1, be largely memorised, or be substantially off-topic.'
      ],
      0: [
        'No attempt (answer sheet is blank), or no meaningful language produced.'
      ]
    }
  },

  {
    key: 'part12',
    name: 'Part 1.2',
    description: 'Formal email',
    max: 5,
    labels: {
      5: 'C1 or above',
      4: 'Higher B2',
      3: 'Lower B2',
      2: 'B1',
      1: 'A2',
      0: 'No attempt'
    },
    bands: {
      5: [
        'The response fulfils the communicative purpose fully, clearly and effectively. It addresses and develops all the required content, selecting and organising information appropriately for the intended reader.',
        'The formal register is consistently appropriate and language is used flexibly to perform the required functions.',
        'A wide range of grammatical structures is used with a high degree of control; occasional minor errors do not affect communication.',
        'Vocabulary is varied, precise and appropriate to the task, with effective paraphrasing where needed.',
        'Ideas are well connected and logically organised, with cohesive devices used flexibly rather than mechanically.',
        'Spelling, punctuation and paragraphing are consistently accurate and support easy reading, apart from occasional minor slips.'
      ],
      4: [
        'The response fulfils the communicative purpose clearly and effectively. It addresses all or nearly all required content and develops the main points sufficiently.',
        'The formal register is consistently appropriate, with only occasional minor lapses.',
        'A range of grammatical structures, including complex structures, is used with generally good control; errors do not normally impede communication.',
        'Vocabulary is sufficiently broad and precise to discuss the required content, with occasional inappropriate choices that do not affect meaning.',
        'Ideas are logically organised and connected using a range of appropriate cohesive devices.',
        'Spelling and punctuation are generally accurate, with minor errors that do not affect readability.'
      ],
      3: [
        'The response generally fulfils the communicative purpose but may lack some clarity, development or consistency. Most required content is addressed, although some points may be insufficiently developed.',
        'The formal register is generally appropriate but may occasionally become inconsistent or too informal.',
        'Some complex grammatical structures are used successfully, although errors become more noticeable as complexity increases.',
        'Vocabulary is sufficient for the task but may show repetition, imprecision or occasional inappropriate choices.',
        'The response has an overall logical organisation, although connections between some ideas may be simple, mechanical or unclear.',
        'Spelling and punctuation are generally accurate enough for communication.'
      ],
      2: [
        'The response communicates the main message but provides limited evidence of B2-level performance.',
        'Some required content is addressed, but important points may be missing or insufficiently developed.',
        'The formal register may be inconsistent, although the intended purpose is generally understandable.',
        'The writer can produce connected text using mainly familiar grammatical structures; errors become noticeable when more complex structures are attempted.',
        'Vocabulary is sufficient for straightforward communication but may be repetitive or imprecise.',
        'The response uses basic cohesive devices and follows a generally linear sequence of ideas.',
        'Spelling and punctuation errors may affect readability.',
        'The response may be substantially underlength (less than 50%).'
      ],
      1: [
        'The response provides limited evidence of the ability to communicate the required message.',
        'It addresses only a small amount of the required content and relies mainly on simple sentence structures.',
        'Errors in grammar, vocabulary, spelling and punctuation are frequent and may impede understanding.',
        'Ideas are weakly connected or presented mainly as separate sentences.',
        'There is limited awareness of the formal relationship between writer and reader.',
        'The response may be substantially underlength (less than 25%) or contain substantial irrelevant material.'
      ],
      0: [
        'There is no meaningful language (beyond a few words), or there is substantial use of L1, or the response is completely off-topic (e.g. memorized script, guessing), or no attempt (answer sheet is blank).'
      ]
    }
  },

  {
    key: 'part2',
    name: 'Part 2',
    description: 'Blog post, article or forum post',
    max: 6,
    labels: {
      6: 'Above C1',
      5: 'C1',
      4: 'Higher B2',
      3: 'Lower B2',
      2: 'B1',
      1: 'A2',
      0: 'No attempt'
    },
    bands: {
      6: [
        'The response fulfils the communicative purpose with a very high degree of precision, flexibility and control. It develops a clear and well-substantiated position, handling complex ideas and alternative perspectives effectively. Arguments are logically developed and relationships between ideas, including subtle contrasts, qualifications and implications, are expressed precisely.',
        'A wide range of grammatical structures is used with very high control.',
        'Vocabulary is broad, precise and used flexibly, allowing the writer to express subtle distinctions and shades of meaning.',
        'The text is highly coherent and cohesive, with discourse organised naturally and effectively.',
        'The genre and tone are consistently appropriate to the intended publication context.',
        'Spelling, punctuation and paragraphing are consistently accurate.'
      ],
      5: [
        'The response fulfils the communicative purpose clearly, effectively and in an appropriately developed way. It presents a clear position and develops relevant arguments, examples and/or explanations, including appropriate qualification or consideration of alternative views where relevant to the task. Complex ideas are organised logically, and relationships between ideas are clear rather than dependent on mechanical linking expressions.',
        'A wide range of grammatical structures is used with generally strong control; occasional minor errors do not impede communication.',
        'Vocabulary is varied and sufficiently precise to discuss abstract and less familiar topics, although occasional awkward choices may occur.',
        'The text is well organised into paragraphs and demonstrates flexible use of cohesive devices.',
        'The genre and tone are appropriate to the task.',
        'Spelling and punctuation are consistently accurate apart from occasional minor slips.'
      ],
      4: [
        'The response fulfils the communicative purpose clearly and provides a well-organised discussion of the topic. It presents a clear position and develops the main ideas with relevant reasons, examples or explanations. Some complexity of thought is evident, although ideas may not always be fully qualified or explored.',
        'A range of grammatical structures, including complex forms, is used with generally good control; errors do not normally affect communication.',
        'Vocabulary is sufficiently broad for the topic, with some ability to discuss abstract ideas, although occasional imprecision or repetition may occur.',
        'Ideas are logically organised and connected through appropriate cohesive devices, though some transitions may be predictable or mechanical.',
        'The genre and tone are generally appropriate.',
        'Spelling and punctuation are generally accurate, with minor errors that do not affect readability.'
      ],
      3: [
        'The response addresses the topic and communicates a generally clear message, but development may be uneven. The writer presents a position, although it may not always be clearly maintained or sufficiently supported. Some relevant reasons or examples are provided, but ideas may be repetitive, insufficiently developed or occasionally off-topic.',
        'Some complex grammatical structures are used successfully, although errors become more noticeable with greater complexity.',
        'Vocabulary is sufficient to discuss the topic but may lack precision or variety.',
        'The text has an overall organisation, but connections between ideas may sometimes be unclear, repetitive or mechanical.',
        'The response is generally appropriate to the genre, although aspects of tone or style may be inconsistent.'
      ],
      2: [
        'The response communicates a basic position on the topic but provides limited evidence of B2-level writing. Ideas are generally relevant but may be simple, repetitive or insufficiently developed. Reasons and examples are basic, and the writer may have difficulty developing an argument systematically.',
        'Grammatical control is generally good for simple structures, while errors are more frequent when complex structures are attempted.',
        'Vocabulary is adequate for familiar topics but may be repetitive or imprecise, sometimes affecting clarity.',
        'The text uses basic cohesive devices to connect ideas in a mostly linear sequence.',
        'Organisation and paragraphing may be limited.',
        'Spelling and punctuation errors may affect readability.',
        'The response may be substantially underlength (less than 50%).'
      ],
      1: [
        'The response provides limited evidence of the ability to produce connected writing. It shows limited focus on the topic and contains simple, sometimes unclear or partly irrelevant ideas.',
        'It relies mainly on simple grammatical structures, with frequent errors that sometimes impede understanding.',
        'Vocabulary is limited and often insufficient to express the required ideas.',
        'The text may consist mainly of separate sentences with little organisation or cohesion.',
        'Spelling and punctuation errors are frequent and may affect readability.',
        'The response may be substantially underlength (less than 25%).'
      ],
      0: [
        'There is no meaningful language (beyond a few words), or there is substantial use of L1, or the response is completely off-topic (e.g. memorized script, guessing), or no attempt (answer sheet is blank).'
      ]
    }
  }
];

export const WRITING_PART_KEYS = WRITING_PARTS.map(p => p.key);

export const writingPart = key => WRITING_PARTS.find(p => p.key === key);

/** The descriptor for a band, as the array of statements the board wrote. */
export function writingDescriptor(key, band) {
  const part = writingPart(key);
  const value = Number(band);
  return part?.bands[value] || [];
}

export function writingLabel(key, band) {
  return writingPart(key)?.labels[Number(band)] || '';
}

/**
 * The level a band shows, read off the board's own label.
 *
 * Used only for PARTIAL submissions, which cannot be converted to a score out
 * of 75. "Higher B1" and "Lower B1" are both B1; "B2 or above" is B2 (the most
 * the part can establish); A2 and below are below B1, which is the lowest
 * level this exam reports.
 */
const BAND_LEVEL = {
  part11: { 5: 'B2', 4: 'B1', 3: 'B1', 2: null, 1: null, 0: null },
  part12: { 5: 'C1', 4: 'B2', 3: 'B2', 2: 'B1', 1: null, 0: null },
  part2: { 6: 'C1', 5: 'C1', 4: 'B2', 3: 'B2', 2: 'B1', 1: null, 0: null }
};

/** 'B1' | 'B2' | 'C1', or null for below B1. */
export function writingBandLevel(key, band) {
  return BAND_LEVEL[key]?.[Number(band)] ?? null;
}

/**
 * The band above the one awarded, and what it asks for.
 *
 * Unlike the speaking scale there are no undescribed bands here — every band
 * from 0 to the part's maximum has its own text — so this is simply the next
 * one up, or null at the ceiling.
 */
export function writingNextBand(key, band) {
  const part = writingPart(key);
  const value = Number(band);
  if (!part || !Number.isFinite(value) || value >= part.max) return null;

  const next = value + 1;
  return {
    band: next,
    label: part.labels[next] || '',
    descriptor: part.bands[next] || []
  };
}

/**
 * The scale as the marker is shown it.
 *
 * Built once at module load: this is the cacheable half of every writing
 * marking prompt and must be byte-identical between calls or the cache never
 * hits.
 */
export const WRITING_PROMPT_BLOCK = WRITING_PARTS.map(part => {
  const bands = Object.keys(part.bands)
    .map(Number)
    .sort((a, b) => b - a)
    .map(band => `  ${band} (${part.labels[band]}): ${part.bands[band].join(' ')}`)
    .join('\n');

  return `${part.name} — ${part.description} [${part.key}], scored 0-${part.max}\n${bands}`;
}).join('\n\n');

export default {
  WRITING_PARTS,
  WRITING_PART_KEYS,
  writingPart,
  writingDescriptor,
  writingLabel,
  writingNextBand,
  writingBandLevel,
  WRITING_PROMPT_BLOCK
};
