/**
 * Error Hunter: one mistake per sentence, the kind Uzbek and Russian speakers
 * make in the speaking and writing exams.
 *
 * Each entry: the sentence with the wrong word in [brackets], the right
 * replacement ('' means "delete it"), two wrong fixes, and a one-line reason
 * in Uzbek. The student taps the wrong word, then picks the fix.
 */

const RAW = [
  ['I [am] agree with your opinion.', '', ['is', 'was'], "agree — fe'l, oldidan am kerak emas: I agree."],
  ['She is married [with] a doctor.', 'to', ['on', 'for'], 'married to someone — "bilan" emas, to.'],
  ['We discussed [about] the problem yesterday.', '', ['on', 'of'], 'discuss dan keyin predlog kelmaydi: discuss the problem.'],
  ['He is good [in] English.', 'at', ['on', 'with'], 'good at something.'],
  ['I have lived here [since] three years.', 'for', ['from', 'during'], 'Muddat (three years) bilan for; since — boshlanish nuqtasi bilan.'],
  ['She gave me some useful [informations].', 'information', ['informationes', "information's"], 'information sanalmaydi — ko\'plik -s olmaydi.'],
  ['People [is] worried about the climate.', 'are', ['was', 'be'], 'people — ko\'plik: people are.'],
  ['He [don\'t] like coffee.', "doesn't", ['not', "isn't"], "he/she/it bilan doesn't."],
  ['I didn\'t [went] to school yesterday.', 'go', ['gone', 'going'], "didn't dan keyin fe'lning 1-shakli: didn't go."],
  ['She can [speaks] three languages.', 'speak', ['spoke', 'speaking'], "can dan keyin fe'l o'zgarmaydi: can speak."],
  ['If I [will] have time, I will call you.', '', ['would', 'shall'], "If qismida will ishlatilmaydi: If I have time."],
  ['I [am] living in Tashkent since 2015.', 'have been', ['was', 'had'], 'since bilan Present Perfect Continuous: I have been living.'],
  ['Everybody [have] a phone nowadays.', 'has', ['having', 'are'], 'everybody — birlik: everybody has.'],
  ['My brother is [more] taller than me.', '', ['most', 'very'], 'taller allaqachon qiyosiy daraja — more kerak emas.'],
  ['This is the [most] biggest city in the country.', '', ['more', 'very'], 'biggest — orttirma daraja, most ortiqcha.'],
  ['I look forward to [meet] you.', 'meeting', ['met', 'meets'], 'look forward to + -ing: meeting.'],
  ['The news [are] very bad today.', 'is', ['were', 'be'], 'news — birlik: the news is.'],
  ['He [works] as a teacher since 2010.', 'has worked', ['worked', 'working'], 'since bilan Present Perfect: has worked.'],
  ['Although it was raining, [but] we went out.', '', ['so', 'and'], 'although va but birga ishlatilmaydi.'],
  ['Despite [of] the rain, we played football.', '', ['for', 'from'], 'despite dan keyin of yo\'q: despite the rain.'],
  ["I'm used to [wake] up early.", 'waking', ['woke', 'woken'], 'be used to + -ing: used to waking up.'],
  ['She has two [childs].', 'children', ['childrens', 'child'], 'child — children (noto\'g\'ri ko\'plik).'],
  ['It depends [of] the weather.', 'on', ['from', 'in'], 'depend on something.'],
  ['I am [interesting] in history.', 'interested', ['interest', 'interests'], "Odam — interested; narsa — interesting."],
  ['The film was very [bored].', 'boring', ['bore', 'boredom'], 'Film zerikarli — boring; odam zerikadi — bored.'],
  ['He [said] me that he was tired.', 'told', ['spoke', 'talked'], "say something; tell someone: he told me."],
  ["Let's [make] a photo together.", 'take', ['do', 'give'], 'take a photo.'],
  ['I [did] a mistake in the test.', 'made', ['took', 'had'], 'make a mistake.'],
  ['Please [do] a decision soon.', 'make', ['have', 'give'], 'make a decision.'],
  ['She is afraid [from] dogs.', 'of', ['about', 'by'], 'afraid of something.'],
  ['We were [waiting] him for an hour.', 'waiting for', ['waited', 'wait'], 'wait for someone.'],
  ['He entered [into] the room quietly.', '', ['to', 'in'], "enter dan keyin predlog kerak emas: entered the room."],
  ['I prefer tea [than] coffee.', 'to', ['from', 'then'], 'prefer A to B.'],
  ['Children should [listen] their parents.', 'listen to', ['hear', 'listened'], 'listen to someone.'],
  ["It's difficult for me [understanding] this text.", 'to understand', ['understand', 'understood'], "difficult for me + to + fe'l."],
  ['I [have] 20 years old.', 'am', ['has', 'be'], 'Yosh be bilan aytiladi: I am 20 years old.'],
  ['She [is] working here for five years.', 'has been', ['was', 'had'], 'for five years — hozirgacha: has been working.'],
  ['How long [time] does it take?', '', ['times', 'timing'], 'How long — time so\'zisiz.'],
  ['There are many [peoples] in the park.', 'people', ['persones', 'person'], 'people allaqachon ko\'plik.'],
  ['I will call you when I [will] arrive.', '', ['would', 'shall'], 'when qismida kelasi zamon uchun ham Present Simple: when I arrive.'],
  ['He has [less] friends than his brother.', 'fewer', ['little', 'least'], 'Sanaladigan (friends) — fewer; sanalmaydigan — less.'],
  ['[Much] students failed the exam.', 'Many', ['Lot', 'Much of'], 'Sanaladigan ot bilan many.'],
  ['She [go] to work by bus every day.', 'goes', ['going', 'gone'], 'she + Present Simple: goes.'],
  ['We [was] at home all day.', 'were', ['be', 'is'], 'we — were.'],
  ['Yesterday I [have] met an old friend.', '', ['has', 'had'], "Yesterday — Past Simple: I met. have kerak emas."],
  ['[This] shoes are too small.', 'These', ['That', "This's"], 'Ko\'plik ot bilan these.'],
  ['She speaks English very [good].', 'well', ['goodly', 'nice'], "Fe'lni ravish tasvirlaydi: speaks well."],
  ['He is the man [which] helped me.', 'who', ['what', 'whom'], 'Odam uchun who.'],
  ['The book [what] I read was interesting.', 'that', ['who', 'whose'], 'Narsa uchun that/which, what emas.'],
  ["I'm [boring] in this lesson.", 'bored', ['bore', 'boredom'], "O'zingiz zerikkan bo'lsangiz — bored."],
  ['My father [is] engineer.', 'is an', ['are', 'was'], 'Kasb oldida a/an: an engineer.'],
  ['He married [with] his classmate.', '', ['to', 'on'], 'marry someone — predlogsiz.'],
  ['Please answer [to] my question.', '', ['for', 'on'], 'answer a question — predlogsiz.'],
  ['We reached [to] the top of the mountain.', '', ['at', 'on'], 'reach a place — predlogsiz.'],
  ['I worked all [the] day and I am tired.', '', ['a', 'an'], 'all day — artiklsiz.'],
  ['[In] the other hand, cars pollute the air.', 'On', ['At', 'By'], 'On the other hand.'],
  ['The price of bread has [raised].', 'risen', ['rose', 'rised'], "rise — rose — risen (o'zi ko'tariladi)."],
  ['She is responsible [of] the project.', 'for', ['about', 'to'], 'responsible for something.'],
  ['I [have] a headache since morning.', 'have had', ['had', 'having'], 'since bilan Present Perfect: have had.'],
  ['There are too [much] cars in the city.', 'many', ['more', 'lot'], 'Sanaladigan ot (cars) — many.'],
  ['He is [very] clever student.', 'a very', ['so', 'too'], 'Birlikdagi sanaladigan ot oldida a: a very clever student.'],
  ['I will finish it [until] Friday.', 'by', ['since', 'during'], "Muddatgacha bajarish — by Friday."],
  ['She [told] that she was busy.', 'said', ['spoke', 'talked'], 'Kimgaligi aytilmasa — said.'],
  ['It was [an] useful lesson.', 'a', ['one', 'some'], 'useful "yu" tovushi bilan boshlanadi — a useful.'],
  ['I walk to school every [days].', 'day', ['dayes', "day's"], 'every + birlik: every day.'],
  ['He studies [hardly] to pass the exam.', 'hard', ['hardy', 'hardness'], 'hardly = "deyarli yo\'q". Qattiq — hard.'],
  ['We need more money [for] to buy a house.', '', ['so', 'in'], 'Maqsad — to buy, for ortiqcha.'],
  ["I haven't seen him [since] a long time.", 'for', ['from', 'during'], 'a long time — muddat: for.'],
  ['Let me [to] help you.', '', ['for', 'at'], "let + fe'l (to siz): let me help."],
  ['He made me [to] wait for an hour.', '', ['for', 'at'], "make someone do something — to siz."],
  ['I am looking forward to [hear] from you.', 'hearing', ['heard', 'hears'], 'look forward to + -ing.'],
  ['It is a [five-stars] hotel.', 'five-star', ['five-stared', 'fives-star'], "Sifat vazifasida ko'plik olmaydi: a five-star hotel."],
  ['It was so hot that we stayed [in] home.', 'at', ['on', 'into'], 'at home.'],
  ['Every [students] must bring a pen.', 'student', ['studentes', "student's"], 'every + birlik.'],
  ['He is taller [then] his brother.', 'than', ['that', 'as'], 'Qiyoslashda than; then — "keyin".'],
  ['[Their] going to the market now.', "They're", ['There', 'The'], "They're = They are."],
  ['[Its] a beautiful day.', "It's", ['Is', 'It'], "It's = It is; its — egalik."],
  ['She is good at [cook].', 'cooking', ['cooked', 'cooks'], 'Predlogdan keyin -ing: good at cooking.'],
  ['Where did you [went] last summer?', 'go', ['gone', 'going'], "did dan keyin 1-shakl: did you go."],
  ["I didn't [understood] the question.", 'understand', ['understanding', 'understands'], "didn't + 1-shakl."],
  ['She [has] visited Samarkand last year.', '', ['have', 'is'], 'last year — Past Simple: she visited.'],
  ['Most [of] people use smartphones.', '', ['from', 'for'], 'Most people (umumiy) — of siz.'],
  ['This is my [the] best friend.', '', ['a', 'an'], 'my va the birga kelmaydi: my best friend.'],
  ['I felt [myself] tired after work.', '', ['me', 'mine'], 'feel tired — myself kerak emas.'],
  ['We [have] discussed this problem last Monday.', '', ['has', 'are'], 'last Monday — Past Simple: we discussed.'],
  ["I'll tell you when [I'll] finish.", 'I', ["I'm", "I'd"], 'when qismida will yo\'q: when I finish.'],
  ['Technology plays an important role [on] our lives.', 'in', ['at', 'for'], 'play a role in something.'],
  ['Parents should pay more attention [for] their children.', 'to', ['on', 'at'], 'pay attention to.'],
  ['Governments should take measures against [of] pollution.', '', ['for', 'to'], 'against dan keyin of yo\'q.'],
  ['Young people spend too much time [in] social media.', 'on', ['at', 'for'], 'on social media.'],
  ['This problem affects [on] everyone.', '', ['to', 'for'], 'affect someone — predlogsiz.'],
  ['It is important to protect [the] nature.', '', ['a', 'an'], 'nature — umumiy ma\'noda artiklsiz.'],
  ['In conclusion, both sides [has] good points.', 'have', ['having', 'is'], 'both sides — ko\'plik: have.'],
  ['The number of cars [are] increasing.', 'is', ['were', 'be'], 'The number of ... — birlik: is.'],
  ['I strongly believe that [the] education is the key to success.', '', ['an', 'a'], "education umumiy ma'noda — artiklsiz."],
  ['I am writing to complain about the service which I received [it] yesterday.', '', ['them', 'this'], 'which allaqachon obyekt — it ortiqcha.'],
  ['I would be grateful if you [can] send me the details.', 'could', ['will', 'may'], "I would be grateful if you could — rasmiy uslub."],
  ['I would like to apply [to] the job of manager.', 'for', ['on', 'at'], 'apply for a job.'],
  ['I am looking forward [for] your reply.', 'to', ['on', 'at'], 'look forward to.'],
  ['Many students are [worry] about the exam.', 'worried', ['worrying', 'worries'], 'be worried about.'],
  ['My sister [have] two cats.', 'has', ['having', 'haves'], 'she — has.'],
  ['I usually [am going] to the gym on Mondays.', 'go', ['went', 'goes'], 'Odat — Present Simple: I usually go.'],
  ['She arrived [to] Tashkent at night.', 'in', ['at', 'into'], 'arrive in a city.']
];

const WORD = /(\[[^\]]+\]|[^\s]+)/g;

function parse([marked, fix, wrong, why], id) {
  // Punctuation written apart from a bracketed word ("[childs].") joins it.
  const tokens = [];
  for (const t of marked.match(WORD)) {
    if (/^[.,!?;:]+$/.test(t) && tokens.length) tokens[tokens.length - 1] += t;
    else tokens.push(t);
  }
  const at = tokens.findIndex(t => t.startsWith('['));
  const words = tokens.map(t => t.replace(/^\[|\](?=[.,!?;:]*$)/g, ''));
  return { id: `eh${id + 1}`, words, at, fix, wrong, why };
}

export const ERROR_ITEMS = RAW.map(parse);

/** The corrected sentence, for the reveal. */
export function corrected(item) {
  const words = [...item.words];
  const original = words[item.at];
  // Keep sentence punctuation that was attached to the wrong word.
  const trail = (original.match(/[.,!?]+$/) || [''])[0];
  words[item.at] = item.fix ? item.fix + trail : '';
  return words.filter(Boolean).join(' ').replace(/\s+([.,!?])/g, '$1').replace(/^(.)/, c => c.toUpperCase());
}

export default ERROR_ITEMS;
