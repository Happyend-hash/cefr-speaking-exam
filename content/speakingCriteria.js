/**
 * The official speaking criteria, verbatim.
 *
 * Source: "B2 Gapirish ko'nikmasini baholash mezoni", Bilimni baholash
 * agentligi. Five criteria, each scored 0-6.
 *
 * WHY THE B2 SHEET AND NOT THE C1 ONE — this is an inference, not something the
 * agency states, so it is written down rather than assumed:
 *
 * The agency publishes a sheet per level, but the multilevel test is one paper
 * that can award B1, B2 or C1, so a rater cannot be picking a sheet by "which
 * paper the candidate sat". Only one sheet can be the multilevel ruler, because
 * B2 band 6 and C1 band 4 describe an identical performance and would produce
 * 75 and 57 through the same conversion table.
 *
 * Run a uniform profile through that table and the B2 sheet's own labels land
 * exactly where they should:
 *
 *   band 6 "daraja talabidan yuqori"      -> 75  -> C1
 *   band 5                                 -> 66  -> C1
 *   band 4 "daraja talabiga mos"           -> 57  -> B2
 *   band 3 "daraja talabiga yaqin"         -> 45  -> B1
 *   band 1 "daraja talabiga javob bermaydi"-> 21  -> below B1
 *
 * The C1 sheet fails the same test: its band 4 means "meets C1" and produces a
 * B2. A real certificate corroborates the B2 reading — speaking 67 sits just
 * above uniform band 5, and that candidate was certified C1.
 *
 * See claude/WHICH-RUBRIC-SHEET.md in the project for the full argument. If a
 * B1 sheet ever turns up whose top bands do NOT repeat this sheet's lower
 * bands, this reading is wrong and everything here needs revisiting.
 *
 * The descriptors are the agency's words and are shown to students unchanged.
 * Do not paraphrase them, do not translate them, and do not "improve" them: a
 * student comparing our feedback against the official sheet must find the same
 * sentence.
 */

/**
 * What each band means, in the agency's own labels.
 *
 * Bands 5 and 2 are defined by the sheet only as the space between their
 * neighbours — that is not vagueness to be filled in, it is how the scale
 * works, and the marker is told so explicitly.
 */
export const BAND_LABELS = {
  6: 'Daraja talabidan yuqori',
  5: "4 va 6 ball oralig'ida",
  4: 'Daraja talabiga mos',
  3: 'Daraja talabiga yaqin',
  2: "1 va 3 ball oralig'ida",
  1: 'Daraja talabiga javob bermaydi',
  0: '1 balldan past'
};

export const BAND_BETWEEN = {
  5: "4 ballning hamma ijobiy tomonlarini hamda 6 ballning ayrim xususiyatlarini namoyon qiladi",
  2: "1 va 3 ball oralig'ida"
};

/**
 * The five criteria in the sheet's own order, with the descriptor for each
 * defined band.
 *
 * `key` is what the rest of the system stores and weights — see
 * services/ScoreConversion.js, where fluencyCoherence carries double weight
 * because the sheet's own heading names two things.
 */
export const CRITERIA = [
  {
    key: 'vocabulary',
    name: "So'z boyligi",
    bands: {
      6: "keng ko'lamli so'z boyligi, jumladan kam qo'llanadigan so'zlar va iboralar; xilma-xil mavzularda fikr bildirish uchun so'z boyligi yetarli; so'z topishga deyarli qiynalmaydi, perifrazadan unumli foydalangan holda leksik bo'shliqlarni to'ldiradi; xatolar ma'noni tushunishga xalal bermaydi",
      4: "yetarlicha so'z boyligiga ega, kam qo'llanadigan so'zlarni ishlatishga harakat qiladi; asosan notanish mavzularda fikrini aniq yetkazishda leksik repertuar nomzodni ba'zan cheklaydi; kam qo'llanadigan so'zlarni ishlatishda ayrim xatolarga yo'l qo'yadi, biroq xatolar ma'noni tushunishga xalal bermaydi; perifrazadan asosan unumli foydalanadi",
      3: "tanish va notanish mavzularda gapira oladi, biroq notanish mavzularda so'z topishga qiynaladi; perifrazadan foydalanishga harakat qiladi, biroq doim ham unumli emas; xatolar ayrim hollarda ma'noni tushunishga xalal beradi",
      1: "so'z boyligi birmuncha cheklangan; tanish mavzularda fikrini bayon qila oladi, biroq notanish mavzularda faqat asosiy ma'noni ifodalaydi; so'z qo'llash bilan bog'liq ko'plab qo'pol xatolarga yo'l qo'yadi; perifrazadan kam hollarda foydalanadi"
    }
  },
  {
    key: 'grammar',
    name: 'Grammatika',
    bands: {
      6: "xilma-xil murakkab strukturalardan samarali foydalanadi; ko'p hollarda grammatik xatolardan holi gaplar tuzadi, biroq ayrim xatoliklar uchrab turadi; xatolarni o'zi tuzatadi va ular ma'noni tushunishga xalal bermaydi",
      4: "sodda va ayrim murakkab strukturalardan foydalanadi; murakkab strukturalarni qo'llashda xatolarga yo'l qo'yadi, biroq ular ma'noni tushunishga deyarli xalal bermaydi",
      3: "xilma-xil sodda strukturalardan foydalanadi; sodda gaplarni tuzishda xatolarga yo'l qo'ymaydi; murakkab strukturalardan kam foydalanadi, ularni qo'llashdagi xatolar ma'noni tushunishga xalal beradi",
      1: "grammatik xilma-xillik cheklangan; ko'p qo'llanadigan sodda strukturalardan foydalanadi, qo'shma gaplarni deyarli qo'llamaydi; ma'noni tushunishga xalal beradigan xatolar tez-tez uchraydi"
    }
  },
  {
    key: 'fluencyCoherence',
    name: 'Nutq ravonligi va matn yaxlitligi',
    bands: {
      6: "matn yaxlitligini saqlagan holda qiyinchiliksiz ravon gapiradi; ayrim hollarda ikkilanish, takror va tuzatishlar uchraydi; bog'lovchi vositalar va diskurs markerlaridan unumli foydalanadi",
      4: "uzun diskurs yaratishga harakat qiladi, biroq ayrim hollarda ikkilanish, takror va o'zini tuzatishlar sababli matn yaxlitligi buzilishi mumkin; xilma-xil bog'lovchi vositalar va diskurs markerlaridan foydalanadi, biroq doim ham o'rinli emas",
      3: "odatda takror, o'zini tuzatish yoki sekin gapirish orqali nutq ravonligini ta'minlaydi; ayrim bog'lovchilar va markerlarni me'yordan ortiq ishlatadi; sodda nutq hosil qilishi ravon, biroq murakkab fikrlarni ifodalashda nutq ravon emas",
      1: "sezilarli to'xtamlar bilan sekin gapiradi, takror va o'zini tuzatish tez-tez uchraydi; sodda gaplarni ayrim sodda markerlar yordamida o'zaro bog'lay oladi, biroq matn yaxlitligida buzilishlar uchraydi"
    }
  },
  {
    key: 'communicative',
    name: 'Kommunikativ samaradorlik',
    bands: {
      6: "javoblar to'liq mavzuga aloqador; ayrim hollarda uslubiy vositalar noo'rin tanlansa-da, fikrlarni aniq va ravshan ifodalaydi; muloqotga kirishish va uni olib borishda yordamga tayanmaydi",
      4: "javoblar mavzuga aloqador; uslubiy noo'rin tanlangan til vositalari ayrim hollarda nutqiy g'alizlik keltirib chiqaradi, biroq muloqot o'rnata oladi; muloqotga kirishish va uni olib borishda deyarli yordamga tayanmaydi",
      3: "javoblar asosan mavzuga aloqador; tanlangan uslubiy vositalar doim ham o'rinli emas; muloqotga kirishish va uni olib borishda ozroq yordamga tayanadi",
      1: "javoblar qisman mavzuga aloqador; uslubiy noo'rin tanlangan til vositalari nutqiy g'alizlik chiqaradi; muloqotga kirishish va uni olib borishda yordam va ko'makka muhtoj"
    }
  },
  {
    key: 'pronunciation',
    name: 'Talaffuz',
    bands: {
      6: "talaffuz tushunarli; ohang mazmunga mos; so'z va gap urg'usi o'rinli; tovushlarni aniq va tiniq talaffuz qiladi",
      4: "ohang, urg'u va tempdan samarali foydalanadi; talaffuz tushunarli, biroq ayrim so'zlarni talaffuz qilishdagi xatolar nutq aniqligini pasaytiradi; ona tili ta'siri sezilarli",
      3: "ohang, urg'u va tempdan ayrim hollarda noto'g'ri yoki noo'rin foydalanadi; ayrim so'zlarni noto'g'ri talaffuz qiladi; ona tili ta'siri sezilarli",
      1: "ohang, urg'u va tempdan ayrim hollarda to'g'ri foydalanadi; talaffuzda xatolar ko'p va ular ma'noga ta'sir qiladi; ona tili ta'siri kuchli"
    }
  }
];

export const CRITERION_KEYS = CRITERIA.map(c => c.key);

/** One criterion by key, or undefined. */
export const criterionByKey = key => CRITERIA.find(c => c.key === key);

/**
 * The descriptor for a band, falling back to the "between" wording for the
 * bands the sheet defines only as the space between their neighbours.
 */
export function descriptorFor(key, band) {
  const criterion = criterionByKey(key);
  if (!criterion) return '';
  const value = Number(band);
  if (criterion.bands[value]) return criterion.bands[value];
  if (BAND_BETWEEN[value]) return BAND_BETWEEN[value];
  return '';
}

/**
 * The band above the one awarded, and what it describes.
 *
 * This is the most useful thing on a student's result page: "your coherence is
 * 3" teaches nothing, while the sentence describing band 4 says exactly what to
 * change. Returns null at the top of the scale, where there is nothing above.
 */
export function nextBandFor(key, band) {
  const value = Number(band);
  if (!Number.isFinite(value) || value >= 6) return null;

  const criterion = criterionByKey(key);
  if (!criterion) return null;

  const next = value + 1;

  // Bands 5 and 2 are defined only as the space between their neighbours, so
  // handing a candidate at band 4 the sentence "shows some features of band 6"
  // tells them nothing they can act on. What they need is band 6 itself: by the
  // agency's own definition, reaching 5 means starting to show what 6
  // describes. So the descriptor shown is always a real one, and `between`
  // tells the page to say why it is showing the band above the next.
  let described = next;
  while (described <= 6 && !criterion.bands[described]) described += 1;
  if (described > 6) return null;

  return {
    band: next,
    label: BAND_LABELS[next] || '',
    describes: described,
    between: described !== next,
    descriptor: criterion.bands[described]
  };
}

/**
 * The criteria as the marker is shown them.
 *
 * Built once at module load and reused, because this text is the cacheable half
 * of every marking prompt — it must be byte-identical between calls or the
 * cache never hits.
 */
export const CRITERIA_PROMPT_BLOCK = CRITERIA.map(criterion => {
  const bands = [6, 4, 3, 1]
    .map(band => `  ${band} (${BAND_LABELS[band]}): ${criterion.bands[band]}`)
    .join('\n');
  return `${criterion.name} [${criterion.key}]\n${bands}`;
}).join('\n\n');

export default { CRITERIA, CRITERION_KEYS, BAND_LABELS, descriptorFor, nextBandFor, CRITERIA_PROMPT_BLOCK };
