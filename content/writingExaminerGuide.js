/**
 * How official Multilevel writing examiners are trained to mark.
 *
 * Source: the board's "Writing Assessor Training" course on bilimera.uz
 * (Bilim Era), read in full on 2026-10-06 from Jamshid's examiner account:
 * the test specifications, the rating-scale lessons for each part, the
 * adjacent-level lessons, the six-step rating process, uneven profiles,
 * examiner bias, word count and problematic responses, and the officially
 * graded sample scripts. See claude/WRITING-EXAMINER-TRAINING.md in the
 * project for the full notes.
 *
 * The rating scales themselves are in content/writingCriteria.js (verbatim,
 * and checked against the course's own "Rating scales" PDF the same day).
 * This file is the METHOD for applying them, and the official calibration
 * samples. Both go into the cached half of the writing marker's prompt.
 */

export const WRITING_EXAMINER_METHOD = `THE OFFICIAL EXAMINER METHOD (from the board's Writing Assessor Training):

The only question is: which band best represents the candidate's DEMONSTRATED
writing performance? Not whether you like the answer, agree with its opinion,
or think the candidate "deserves" more.

TARGET LEVEL OF EACH PART (from the test specification):
- Part 1.1, informal email, about 50 words: target B1. Bands 3-4 need a B1
  performance; band 5 is beyond B1.
- Part 1.2, formal email, 120-150 words: target B2. Bands 3-4 need a B2
  performance; band 5 is beyond B2.
- Part 2, blog / forum / magazine article, 180-200 words: target C1. Band 5
  needs a C1 performance; band 6 is beyond C1.

HOW LEVELS DIFFER (Weir's socio-cognitive ladder, used by the course):
A1 = word/phrase-level language use; A2 = sentence level (separate simple
sentences); B1 = paragraph level (a connected message); B2 = discourse/text
level (clear, systematically developed ideas with relevant support); C1 =
inter-text level (complex subjects, sub-themes integrated, points developed
and rounded off, ideas qualified and related precisely).

THE SIX-STEP RATING PROCESS — follow it for every part:
1. Read the task: know exactly what the candidate was asked to do, including
   every action point in the message they are answering.
2. Read the response for meaning. Do not begin by counting errors.
3. Form an overall judgement: what level does this performance represent?
4. Check the descriptors: identify the evidence for that provisional band.
5. Compare the adjacent bands. Ask "why is this not one band lower?" and
   "why is this not one band higher?" Name the evidence that keeps it out of
   the higher band.
6. Assign the final band on the best overall fit.

THE RATER QUESTION FOR EACH PART:
- Part 1.1 (A2 vs B1): can the candidate sustain a connected message, or are
  they mainly producing separate, simple sentences?
- Part 1.2 (B1 vs B2): does the candidate merely communicate the main
  message, or do they develop and support the points systematically?
- Part 2 (B2 vs C1): does the candidate merely discuss the issue clearly, or
  do they handle complexity flexibly and precisely — qualifying claims,
  identifying conditions, relating factors, developing a nuanced position?
  A C1 writer is NOT a B2 writer who makes fewer mistakes.
- Above C1 (Part 2 band 6) is NOT earned by long sentences, rare vocabulary,
  many linking words, more than 200 words, fewer errors or memorised
  "advanced" phrases on their own. It needs complex ideas handled with
  greater flexibility, nuance, precision and exceptional control.

HIGHER vs LOWER WITHIN A LEVEL (band 4 vs band 3) is NOT "band 3 has more
errors". Lower = the candidate can do the task but development, precision or
control are limited. Higher = the task is done clearly, with development and
generally good control and precision.

RANGE IS NOT CONTROL. Range is the variety and complexity of language the
candidate can use; control is how accurately and effectively they use it.
Complexity alone is not proficiency, and accuracy alone is not proficiency.
"This candidate uses B2 grammar and vocabulary, so it is B2" is a known rater
error: complex language that barely addresses the task, with undeveloped ideas,
the wrong register or weak organisation, may not be B2 overall. Conversely,
some grammatical errors do not stop strong task fulfilment, clear
organisation, developed ideas, the right register and sufficient range from
reaching the level.

ERRORS: never count errors and convert the number into a band. Read,
understand the performance, identify evidence, compare with the descriptors,
assign the band. But control IS part of every descriptor: errors that are
frequent, that make expressions unnatural or unclear, or that grow as the
candidate attempts complexity, are real evidence and the official examiners
do mark them down (see the samples). A few errors must not pull an otherwise
clear performance below its level.

UNEVEN PROFILES: do not average across features. Judge the whole, identify
the strongest and weakest evidence, and decide what level is CONSISTENTLY
demonstrated in the actual response — not the candidate's potential. Give
particular weight to fulfilling the task and communicating at the target
level. An isolated impressive sentence does not lift a mostly-B2 response to
C1; a few slips do not pull a clearly C1 response to B2.

BIAS TO AVOID: halo effect (one impressive feature lifts everything); horn
effect (one weakness drags everything down); leniency or severity (marking
everyone high or low); contrast effect (comparing candidates with each other
instead of with the scale); personal-topic bias (agreeing or disagreeing with
the opinion); knowledge bias (rewarding knowledge of the topic).

PROBLEMATIC RESPONSES (official rules):
- Off-topic, reproducing the task's own language, or formulaic / memorised:
  Part 1.1 = band 1; Parts 1.2 and 2 = band 0.
- Substantially under length: follow the scales (Parts 1.2 and 2: under 50%
  of the required length belongs at band 2 or lower, under 25% at band 1 or
  lower). The system applies this cap after you; you still mark the writing.
- Over length: does NOT automatically lower the band — only when it affects
  communication or shows poor control of the task.
- First language (L1): isolated words lower the band according to how much
  there is; substantial use is treated as off-topic.`;

/**
 * Real exam scripts graded by the board, with the board's own comments.
 * Transcribed by hand from the course's scanned handwriting (spelling and
 * grammar left exactly as the candidates wrote them; a word is marked [?]
 * where the handwriting is unclear).
 */
export const WRITING_OFFICIAL_SAMPLES = `OFFICIAL CALIBRATION SAMPLES — real exam scripts with the board's own band
and comment. They show where the board draws its lines; match its standard,
not a gentler or harsher one of your own.

PROMPT A (Music Club): "We have two major updates to announce. First, our
weekly practices will now take place at 10:00 AM on Monday mornings instead of
after school. Second, we have decided to cancel our live end-of-year concert
for parents and instead record a video to post on social media. How will the
change in practice time impact your morning schedule? Furthermore, what is
your opinion on cancelling the live performance?"

PROMPT B (Sports Club): "We have two key updates for our club schedule.
First, because the building is being painted, all our weekly sessions will be
held outside on the grass field, regardless of bad weather. Second, we are
introducing uniforms that every member must purchase before taking part in
group activities. How will having sessions outside in bad weather affect your
attendance? Furthermore, what is your opinion on making official uniforms for
all members?"

--- Part 1.1, Prompt A — OFFICIAL BAND 2 (A2)
"Hi Anna, How are you? Do you hear about updating to announce? I was quite sad
to hear that as they are going to cancel live performance. I appreciate their
practices, but I would like they shouldn't cancel recording a video. What do
you think about it. Take care Hulkar."
Board's comment: Task fulfilment is limited; some relevant information is
communicated, but not supported with details. Basic vocabulary and sentence
structures are used, but control is weak. Basic linking is attempted despite
being mechanical. Register is generally appropriate.

--- Part 1.1, Prompt B — OFFICIAL BAND 3 (Lower B1)
"Dear Anna, I hope, you're doing well! I receive an e-mail from our Sport Club
about their updates. Did you hear about our session in this week will be held
outside on the grass field, regardless of bad weather. I think it's very well,
because exercising in fresh air very healthy. Second update is our club
introducing new uniforms and each member must purchase it, it is good new, but
prices will not very high. What about you? Best wishes, Gozzal"
Board's comment: Communicates the main topic and gives simple opinions. The
task is only partially fulfilled despite considerable overlength. More complex
structures are attempted, but frequent grammatical errors reduce accuracy and
clarity. Register is appropriate.

--- Part 1.2, Prompt A — OFFICIAL BAND 2 (B1)
"Dear Music Club leader, I'm writing to express my feelings about the new
schedule of Music Club that you have informed via e-mail. As I have started
being a part of this club recently, I really wanted to continue to reach the
top. But unfortunately, changing the time of the lesson will destroy all my
plans. At the same time, with your class I have started Arabic classes which
starts 10.00 am on Monday mornings. It is impossible to change this class into
another one. So, it would be better if you arrange individual lesson with that
very teacher for me. Furthermore, when it comes to cancellation of live
end-of-year concerts, it doesn't affect me seriously. As my parents are living
in another district, recording a video post on social media can be very
suitable for my situation. I look forward to getting a positive answer for my
request. Yours faithfully."
Board's comment: Responds appropriately to both action points, supporting them
with relevant reasons. Generally well organised, with a reasonable range of
vocabulary and complex structures. However, frequent grammatical errors,
awkward collocations and imprecise phrasing reduce linguistic control.
Register is inconsistent.

--- Part 1.2, Prompt A — OFFICIAL BAND 3 (Lower B2)
"Dear the Music club leader, I am writing in response to your email and thank
you for informing us about the new changes in our music club. It is said that
we will attent the classes on Monday mornings at 10 a.m right? and you decided
to cancel live end-of-year concert for parents instead post a recorded video
on social media. I am absolutely pleased with these changes, however we are
really wanted to change our classes to Monday music classes. I and my friend
are going to English classes after the school, so it would be beneficial both
of us to attend Monday morning classes. Furthermore, I think, the reason why
you changed the schedule of music classes is to attend classes with full of
energy, because we will be a very powerfull in the morning instead after
school, and this will affect to our whole day as it best our energy and charge
our batteries to be cheerful during the day. Additionally, live end-of-year
concert for our parents is going to be cancelled and instead will be held via
recorded video. I believe this also would be helpful for parents, as most of
the students come from long distances and their parents also come to this
concert from a long way. I think, this would be a great chance for them to
attend and to watch videos through the social media. I believe, if you
organize recorded lesson well and it would be beneficial for if you save the
recorded video for a long period of time and not delete it soon, because our
parents are eager to participate in this concert. On no account should they
miss such an opportunity. I look forward into your response and trust that my
feedback proves to be available for the project. Best regards,"
Board's comment: Addresses both aspects and develops ideas with relevant
reasons, consequences and suggestions. Logically organised, with a relatively
broad range of vocabulary and complex structures. However, grammatical and
lexical errors are frequent, and several expressions are unnatural or unclear.
Substantially longer than 120-150 words, indicating limited control of the
task. Lower B2: sufficient development for B2 but inconsistent linguistic
control for Higher B2.

--- Part 2, forum: "Should people spend less time on their smartphones?"
(180-200 words) — OFFICIAL BAND 3 (Lower B2)
"Opinions vary regarding whether people should allocate less time on their
smartphones. While this idea could be justified for people who use their
devices without a proper purpose, I believe reducing screen-time is not a
one-fits-all measure. From one perspective, using smartphones for shorter
periods could be beneficial for most people. Undeniably, many users rely on
smartphones for only as a source of entertainment. For example, they scroll
social media for hours, play video-games and watch reels longer than
recommended time length. Generally, this comes at the expense of their
valuable time which can be alternatively directed to more meaningful purposes,
such as education, childcare or physical activeness. However, this negative
aspect of smartphones is not always true for everyone. There are those who use
their smartphone as a very powerful educational tool. In other words, they
watch online tutorials, documentaries and search for necessary academic
materials. Apart from studies, these gadgets play a pivotal role for many
individuals in earning money. For instance, some people depend on smartphones
for filming content and running online profiles and channels. The more they
use their phone for work, the more profit they may earn, in turn. In
conclusion, deciding on reducing the amount of time on smartphones is not
simple. Based on how individuals approach their use, smartphones could be a
blessing or a curse."
Board's comment: Addresses the topic clearly and presents both sides with
relevant reasons and examples; generally well organised, clear paragraphing,
appropriate linking. Reasonably broad vocabulary and a variety of complex
structures attempted. However, frequent grammatical errors and some inaccurate
or unnatural word combinations reduce precision; some ideas are developed less
fully than others; and it exceeds the word limit.

--- Part 2, same forum topic — OFFICIAL BAND 4 (Higher B2)
"Have you ever wondered how people spend less time for smartphones shaping
our daily lives? It is a topic that is everywhere lately, yet everyone has a
different take on it. Personally, I have been diving into this recently and I
have come to some interesting conclusions, that I will share with you all. On
the one hand, it is hard to deny that spend time their smartphones or social
media offers incredible benefits, especially when it comes to increasing
broaden their horizons or world of knowledge. The main reason for this is lack
of self-discipline. In my experience, focusing on this has allowed me to see
thing from a fresh perspective. It is not just a trend; it is a practical way
to improve our routine and gain a sense of growths. On the other hand, it is
not all sunshine and rainbows. One common challenge is lack of time. This is
mainly because people may not have enough motivation. Many find it
overwhelming at first, but I firmly believe these hurdles are just stepping
stones, if we stay consistant the results are definitly worth the effort. All
things considered, while everyone spend less time on their phones undoubtedly
carries certain complexities, its profound influence on modern society
undeniable. In my view, rather than turning a blind eye to this phenomenon, we
ought to cultivate a strategic and well-informed approach. What are yours
takeaways on this topic? Do you believe the current trajectory is sustainable
and proactive measures can we harness it is a full prospective approach? Drop
your thoughts and experiences in the comments below!"
Board's comment: Addresses the topic clearly and develops ideas from different
perspectives with personal examples and explanations; well organised, a wide
range of linking and relatively sophisticated vocabulary, good control of
complex sentences, a generally clear line of argument. However, some
grammatical errors and unnatural or inaccurate lexical combinations
occasionally reduce clarity; some expressions are overly formulaic or
unnecessarily complex; considerably longer than 180-200 words. Higher B2 —
greater accuracy, lexical precision and concision would be needed for C1.`;

export default { WRITING_EXAMINER_METHOD, WRITING_OFFICIAL_SAMPLES };
