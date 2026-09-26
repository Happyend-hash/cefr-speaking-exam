/**
 * The official speaking rating scales, verbatim.
 *
 * Source: "Rating scale for Multilevel speaking exams" — four tables, one per
 * question group, supplied directly by the school (via @komil_cefr) alongside
 * the official raw-to-reported conversion table (see SPEAKING_PART_MAX and
 * the conversion table in services/ScoreConversion.js).
 *
 * THIS SUPERSEDES content/speakingCriteria.js, the earlier five-criteria B2
 * sheet. That file was always an inference — its own header said so — reached
 * because the agency's actual method had not been supplied yet. It is wrong in
 * a specific, checkable way: it scored FIVE weighted criteria out of a raw
 * total of 36, but the sheets below score FOUR parts out of a raw total of
 * 21 — 5 + 5 + 5 + 6 — which is exactly the ceiling the new conversion table
 * expects (21 -> 75). See claude/WHICH-RUBRIC-SHEET.md and
 * claude/OFFICIAL-SCORE-CONVERSION.md for the open question this resolves.
 *
 * ONE HOLISTIC BAND PER PART, not five separate criteria averaged together —
 * confirmed against the school's material. Each part's descriptor already
 * names several dimensions (what the candidate can do, grammar, vocabulary,
 * fluency/hesitation, how ideas connect, pronunciation) and the rater weighs
 * all of them into ONE band for that part. This is the same shape as writing
 * (content/writingCriteria.js) and should be read the same way: holistic, not
 * analytic — do not score the dimensions separately and average them.
 *
 * WHY THIS IS BETTER THAN THE OLD SYSTEM, STRUCTURALLY, NOT JUST BY SOURCE:
 * the old sheet forced every answer through the SAME five criteria regardless
 * of which part produced it, which is what made "Part 1 can only ever show
 * B1, Part 3 is where C1 shows" a special rule the marker had to be told and
 * a real one to get wrong. Here each part has ITS OWN scale with its own
 * ceiling built in — Part 1.1 tops out at "Above A2", Part 3 at "Above C1" —
 * so a short Part 1.1 answer is simply judged as a Part 1.1 answer, on a
 * scale that was never going to ask it to prove C1 in the first place.
 *
 * The four parts, in the order the exam is taken:
 *
 *   part11  Questions 1-3   three short personal questions      0-5
 *   part12  Questions 4-6   picture description & comparison    0-5
 *   part2   Question 7      one long turn, three linked prompts 0-5
 *   part3   Question 8      balanced argument / debate          0-6
 *
 * The descriptors are the school's own words and are shown to students
 * unchanged. Do not paraphrase them, do not translate them, and do not
 * "improve" them: a student comparing our feedback against the official
 * sheet must find the same sentence.
 */

export const SPEAKING_PARTS = [
  {
    key: 'part11',
    name: 'Part 1.1',
    description: 'Three short personal questions (Q1-3)',
    max: 5,
    labels: {
      5: 'Above A2',
      4: 'Higher A2',
      3: 'Lower A2',
      2: 'Higher A1',
      1: 'Lower A1',
      0: 'No meaningful language'
    },
    bands: {
      5: [
        'Can communicate clearly and effectively on familiar personal topics, producing connected responses with some development and elaboration.',
        'Can explain simple opinions, preferences or experiences and provide relevant reasons or details.',
        'Uses a range of basic and some less familiar grammatical structures with generally good control.',
        'Vocabulary is sufficiently varied and appropriate for the topics, with occasional attempts at more precise expression.',
        'Speech is generally fluent, with only occasional hesitation, repetition or reformulation.',
        'Ideas are linked into a simple, coherent response.',
        'Pronunciation is clear and generally easy to understand.'
      ],
      4: [
        'Can produce connected sentences to communicate information, describe experiences, and express simple opinions or preferences.',
        'Can provide brief explanations, reasons or supporting details, although development may be limited.',
        'Uses a range of basic grammatical structures with generally adequate control, though errors are noticeable.',
        'Vocabulary is generally sufficient for familiar topics but may be repetitive or limited in precision.',
        'Some hesitation, repetition and reformulation occur but usually do not prevent communication.',
        'Ideas can be linked into a simple sequence.',
        'Pronunciation is generally understandable, although some words or sounds may require listener attention.'
      ],
      3: [
        'Can communicate basic information and express simple opinions about familiar personal topics.',
        'Can provide brief descriptions or responses beyond isolated words or phrases, but has limited ability to extend or explain ideas.',
        'Uses mainly basic grammatical structures, with frequent errors that may sometimes affect clarity.',
        'Vocabulary is limited but generally sufficient for familiar topics.',
        'Hesitation, repetition and reformulation are noticeable and may interrupt the flow of speech.',
        'Ideas are usually linked only in a simple way.',
        'Pronunciation is generally understandable, though the listener may occasionally need to make an effort.'
      ],
      2: [
        'Can communicate simple information about familiar personal topics using familiar words, phrases and basic sentences.',
        'Can respond to questions and provide limited personal information or simple descriptions, but has difficulty extending responses.',
        'Uses a limited range of basic grammatical structures with frequent errors.',
        'Vocabulary is mainly limited to familiar words and expressions.',
        'Speech is often hesitant, with frequent pauses, repetition or reformulation.',
        'Ideas are usually expressed as separate simple statements.',
        'Pronunciation is sometimes difficult to understand.'
      ],
      1: [
        'Can produce isolated words, memorised expressions and very simple sentences related to familiar personal information.',
        'Can communicate only very basic information and has considerable difficulty responding beyond short, formulaic utterances.',
        'Uses a very limited range of grammatical structures and vocabulary, with frequent errors.',
        'Speech is characterised by frequent pauses, repetition and breakdowns.',
        'Ideas are rarely connected.',
        'Pronunciation may frequently interfere with understanding.'
      ],
      0: [
        'There is no meaningful language or the responses are entirely unrelated to the task (e.g. memorized answers, guessing).'
      ]
    }
  },

  {
    key: 'part12',
    name: 'Part 1.2',
    description: 'Picture description and comparison (Q4-6)',
    max: 5,
    labels: {
      5: 'Above B1',
      4: 'Higher B1',
      3: 'Lower B1',
      2: 'Higher A2',
      1: 'Lower A2',
      0: 'No meaningful language'
    },
    bands: {
      5: [
        'Can communicate effectively and relatively fluently when describing, comparing and discussing familiar public, educational or everyday topics.',
        'Can develop ideas beyond a straightforward sequence, give reasons and explanations, and express and support opinions with relevant detail.',
        'Uses a range of grammatical structures with generally good control, including some more complex forms.',
        'Vocabulary is sufficiently broad and flexible to express ideas with some precision, although occasional limitations may occur.',
        'Speech is generally fluent, with only occasional hesitation or reformulation.',
        'Ideas are clearly connected and logically organised.',
        'Pronunciation is clear and generally easy to understand.'
      ],
      4: [
        'Can produce a clear, connected response when describing and comparing the visual information and expressing opinions or preferences.',
        'Can develop main ideas with reasons, explanations or examples, although development may not always be even.',
        'Uses a range of familiar grammatical structures with reasonable control and some successful use of more complex forms.',
        'Vocabulary is adequate and shows some flexibility, although repetition or occasional imprecision may occur.',
        'Speech is generally sustained, with noticeable but manageable hesitation.',
        'Ideas are organised into a connected sequence and relationships between ideas are generally clear.',
        'Pronunciation is generally clear and intelligible.'
      ],
      3: [
        'Can give a straightforward description and comparison and express opinions with simple reasons or explanations.',
        'Can produce a connected response rather than a series of isolated sentences, but development of ideas is limited.',
        'Uses mainly familiar grammatical structures with reasonable control, although errors become more frequent when attempting more complex forms.',
        'Vocabulary is adequate for familiar topics but may be repetitive or lack precision.',
        'Hesitation, repetition and reformulation are noticeable but generally do not prevent communication.',
        'Ideas are linked into a simple, linear sequence.',
        'Pronunciation is generally intelligible.'
      ],
      2: [
        'Can communicate basic information about the visual material and familiar topics using simple sentences and familiar expressions.',
        'Can make simple comparisons and express basic preferences or opinions, but has difficulty providing sufficient reasons or developing ideas.',
        'Uses a limited range of basic grammatical structures with frequent errors.',
        'Vocabulary is sufficient for simple, familiar ideas but often repetitive.',
        'Speech contains frequent pauses, repetition and reformulation.',
        'Ideas are mainly presented as separate statements or simple sequences.',
        'Pronunciation may sometimes require listener effort.'
      ],
      1: [
        'Can communicate very simple information related to the visual material or topic using familiar words, phrases and basic sentences.',
        'Can identify or describe some simple features but has considerable difficulty comparing, explaining or expressing developed opinions.',
        'Uses a very limited range of basic grammatical structures and vocabulary, with frequent errors.',
        'Speech is highly hesitant and may contain frequent repetition and breakdowns.',
        'Ideas are rarely connected.',
        'Pronunciation may frequently interfere with understanding.'
      ],
      0: [
        'Speech is insufficient to demonstrate the ability to communicate at A2 level, or there is no meaningful language, or the responses are entirely unrelated to the task (e.g. memorized answers, guessing).'
      ]
    }
  },

  {
    key: 'part2',
    name: 'Part 2',
    description: 'Extended turn on a topic (Q7)',
    max: 5,
    labels: {
      5: 'Above B2',
      4: 'Higher B2',
      3: 'Lower B2',
      2: 'B1',
      1: 'A2',
      0: 'No meaningful language'
    },
    bands: {
      5: [
        'Can give a clear, sustained and well-developed response on a fairly abstract topic.',
        'Can develop and connect ideas effectively, moving from personal experience to broader perspectives and supporting views with relevant reasons, explanations and examples.',
        'Can express, clarify and qualify opinions with a degree of precision and flexibility.',
        'Uses a broad range of grammatical structures with generally high control and a broad vocabulary appropriate to the topic.',
        'Speech is fluent and sustained, with only occasional hesitation or reformulation.',
        'Ideas are logically organised and connected using a range of appropriate cohesive and discourse devices.',
        'Pronunciation is clear and easy to understand.'
      ],
      4: [
        'Can give a clear and sustained response on an abstract topic, developing relevant points with explanations, reasons and supporting detail.',
        'Can express and justify opinions and make connections between personal experience and broader issues, although development may not always be equally strong.',
        'Uses a fairly broad range of grammatical structures with generally good control, including complex forms.',
        'Vocabulary is sufficiently broad and flexible to discuss the topic with some precision.',
        'Speech is generally fluent, with some hesitation when planning or formulating ideas.',
        'Ideas are systematically organised and connected, with an effective range of cohesive devices.',
        'Pronunciation is generally clear and intelligible.'
      ],
      3: [
        'Can produce a sustained response on a fairly abstract topic and develop relevant ideas with some explanation, reasons or examples.',
        'Can express and justify opinions, although ideas may be unevenly developed or insufficiently connected.',
        'Uses a range of grammatical structures, including some complex forms, with generally adequate control, though errors increase with greater complexity.',
        'Vocabulary is sufficient to discuss the topic but may be repetitive or occasionally imprecise.',
        'Hesitation, pausing and reformulation are noticeable but generally allow the candidate to maintain the response.',
        'Ideas are generally connected, although organisation may be uneven and cohesive devices may be limited.',
        'Pronunciation is generally intelligible.'
      ],
      2: [
        'Can produce a straightforward, connected response on a familiar or somewhat abstract topic.',
        'Can express opinions and give simple reasons, explanations or examples, but has difficulty developing ideas in depth or maintaining a clear line of argument.',
        'Uses mainly familiar grammatical structures with reasonable control, although errors increase when attempting more complex forms.',
        'Vocabulary is adequate for expressing familiar ideas but may be repetitive or lack precision.',
        'Hesitation, pausing and reformulation are noticeable but generally do not prevent communication.',
        'Ideas are linked into a simple sequence, although organisation may be uneven.',
        'Pronunciation is generally intelligible.'
      ],
      1: [
        'Can communicate simple information and express basic opinions about familiar aspects of the topic using familiar words, phrases and simple sentences.',
        'Can provide brief descriptions or personal information but has difficulty extending, explaining or connecting ideas.',
        'Uses a limited range of basic grammatical structures and familiar vocabulary, with frequent errors.',
        'Pausing, repetition and reformulation are frequent and may interrupt communication.',
        'Ideas are usually presented as separate points rather than as a connected response.',
        'Pronunciation may require considerable listener effort.'
      ],
      0: [
        'Speech is insufficient to demonstrate the ability to communicate at A2 level, or there is no meaningful language, or the response is entirely unrelated to the task (e.g. memorized answers, guessing).'
      ]
    }
  },

  {
    key: 'part3',
    name: 'Part 3',
    description: 'Balanced argument / debate (Q8)',
    max: 6,
    labels: {
      6: 'Above C1',
      5: 'C1',
      4: 'Higher B2',
      3: 'Lower B2',
      2: 'B1',
      1: 'A2',
      0: 'No meaningful language'
    },
    bands: {
      6: [
        'Can give a clear, fluent, well-structured and persuasive argument on a complex topic.',
        'Can integrate and develop ideas from different perspectives, evaluate and qualify arguments, and synthesise relevant points into a coherent position.',
        'Can use a broad and flexible range of grammatical structures and vocabulary with a high degree of control and precision.',
        'Can express subtle distinctions in meaning and adapt language effectively to the communicative purpose.',
        'Speech is fluent and sustained, with minimal hesitation or reformulation.',
        'Discourse is logically and effectively organised, with flexible use of cohesive and discourse devices.',
        'Pronunciation is clear and natural, with no significant impact on communication.'
      ],
      5: [
        'Can give a clear, well-structured and sustained balanced argument, developing and connecting relevant points from both perspectives.',
        'Can provide convincing reasons, explanations and supporting detail and can acknowledge, contrast or qualify different views.',
        'Uses a broad range of grammatical structures with a high degree of control, including complex forms.',
        'Vocabulary is broad, flexible and sufficiently precise for discussing the topic and expressing relationships between ideas.',
        'Speech is fluent and sustained; occasional hesitation or reformulation does not disrupt the overall flow.',
        'Ideas are logically organised and effectively connected through a range of cohesive and discourse devices.',
        'Pronunciation is clear and easy to understand.'
      ],
      4: [
        'Can give a clear and sustained argument addressing both perspectives and can develop relevant ideas with reasons, explanations or examples.',
        'Can make comparisons and express a position, although evaluation and qualification of different views may be limited or uneven.',
        'Uses a broad range of grammatical structures with generally good control, including complex forms, though errors occur.',
        'Vocabulary is sufficiently broad to discuss the topic and express relationships between ideas, with some imprecision or repetition.',
        'Speech is generally fluent but may include noticeable hesitation when developing more complex ideas.',
        'Ideas are logically organised and generally well connected.',
        'Pronunciation is generally clear and intelligible.'
      ],
      3: [
        'Can produce a sustained response and present relevant points from the two perspectives, although the argument may be only partly developed or balanced.',
        'Can give reasons, explanations or examples to support a position, but connections between ideas may be straightforward.',
        'Uses a range of grammatical structures, including some complex forms, with generally adequate control.',
        'Vocabulary is sufficient for discussing the topic but may be repetitive or occasionally imprecise.',
        'Hesitation, pausing and reformulation are noticeable but generally allow the candidate to maintain the response.',
        'Ideas are generally connected, although organisation may be uneven and cohesive devices may be limited.',
        'Pronunciation is generally intelligible.'
      ],
      2: [
        'Can express a position on the topic and provide some simple reasons or explanations, but has difficulty constructing and sustaining a balanced argument.',
        'Ideas are generally straightforward and may be presented as a sequence of points rather than developed and connected into a coherent argument.',
        'Relies to some extent on the input prompts.',
        'Uses mainly familiar grammatical structures, with errors when attempting more complex forms.',
        'Vocabulary is adequate for expressing basic ideas but limitations make it difficult to discuss the topic fully.',
        'Hesitation, repetition and reformulation are noticeable.',
        'Pronunciation is generally intelligible.'
      ],
      1: [
        'Can communicate simple information or a basic personal opinion related to the topic using familiar words, phrases and simple sentences.',
        'Can mention some relevant points but cannot develop or justify them adequately.',
        'Relies heavily on the input and may reproduce isolated points without establishing clear relationships between them.',
        'Uses a limited range of basic grammatical structures and familiar vocabulary, with frequent errors.',
        'Pausing, repetition and reformulation frequently interrupt communication.',
        'Pronunciation may make understanding difficult.'
      ],
      0: [
        'Speech is insufficient to demonstrate the ability to communicate at A2 level, or there is no meaningful language, or the response is entirely unrelated to the task (e.g. memorized answers, guessing).'
      ]
    }
  }
];

export const SPEAKING_PART_KEYS = SPEAKING_PARTS.map(p => p.key);

/** Maps the exam's own section.part strings ('1.1', '1.2', '2', '3') to a key here. */
export const SECTION_PART_TO_KEY = {
  '1.1': 'part11',
  '1.2': 'part12',
  '2': 'part2',
  '3': 'part3'
};

export const speakingPart = key => SPEAKING_PARTS.find(p => p.key === key);

/** The descriptor for a band, as the array of statements the school wrote. */
export function speakingDescriptor(key, band) {
  const part = speakingPart(key);
  const value = Number(band);
  return part?.bands[value] || [];
}

export function speakingLabel(key, band) {
  return speakingPart(key)?.labels[Number(band)] || '';
}

/**
 * The level a band shows, read off the scale's own label.
 *
 * Used only when a part is missing from an attempt (practice mode, one part
 * at a time) and the total cannot honestly be converted on a table built for
 * all four. "Above X" is read as showing X, never the level above it — the
 * same conservative reading writing uses for "B2 or above" — because the
 * school named X, not the level beyond it.
 *
 * Part 1.1 never reaches this app's reported floor: its own ceiling is
 * "Above A2", which sits entirely below the B1 this app's scale starts at.
 */
const BAND_LEVEL = {
  part11: { 5: null, 4: null, 3: null, 2: null, 1: null, 0: null },
  part12: { 5: 'B1', 4: 'B1', 3: 'B1', 2: null, 1: null, 0: null },
  part2: { 5: 'B2', 4: 'B2', 3: 'B2', 2: 'B1', 1: null, 0: null },
  part3: { 6: 'C1', 5: 'C1', 4: 'B2', 3: 'B2', 2: 'B1', 1: null, 0: null }
};

/** 'B1' | 'B2' | 'C1', or null for below B1. */
export function speakingBandLevel(key, band) {
  return BAND_LEVEL[key]?.[Number(band)] ?? null;
}

/**
 * The band above the one awarded, and what it asks for.
 *
 * Every band from 0 to the part's maximum has its own text in these scales —
 * unlike the old five-criteria sheet, there are no undescribed "between"
 * bands — so this is simply the next one up, or null at the ceiling.
 */
export function speakingNextBand(key, band) {
  const part = speakingPart(key);
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
 * The scales as the marker is shown them.
 *
 * Built once at module load: this is the cacheable half of every speaking
 * marking prompt and must be byte-identical between calls or the cache never
 * hits.
 */
export const SPEAKING_PROMPT_BLOCK = SPEAKING_PARTS.map(part => {
  const bands = Object.keys(part.bands)
    .map(Number)
    .sort((a, b) => b - a)
    .map(band => `  ${band} (${part.labels[band]}): ${part.bands[band].join(' ')}`)
    .join('\n');

  return `${part.name} — ${part.description} [${part.key}], scored 0-${part.max}\n${bands}`;
}).join('\n\n');

export default {
  SPEAKING_PARTS,
  SPEAKING_PART_KEYS,
  SECTION_PART_TO_KEY,
  speakingPart,
  speakingDescriptor,
  speakingLabel,
  speakingBandLevel,
  speakingNextBand,
  SPEAKING_PROMPT_BLOCK
};
