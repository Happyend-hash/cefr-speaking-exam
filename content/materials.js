/**
 * "Materiallar" (2026-11-07): the folders study materials are filed in, and
 * the sub-folders suggested for each. The teacher may type any other
 * sub-folder name when adding a material; students see the sub-folders that
 * actually hold something, suggested ones first in this order.
 */
export const MATERIAL_FOLDERS = [
  { key: 'speaking', title: 'Speaking', icon: '🎙', sections: ['Part 1.1', 'Part 1.2', 'Part 2', 'Part 3', 'Useful phrases & linkers', 'Model answers', 'Assessment criteria'] },
  { key: 'writing', title: 'Writing', icon: '✍️', sections: ['Part 1.1 — informal email', 'Part 1.2 — formal email', 'Part 2 — essay / blog post', 'Templates & useful phrases', 'Model answers', 'Assessment criteria'] },
  { key: 'reading', title: 'Reading', icon: '📖', sections: ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Strategies & tips', 'Answer keys'] },
  { key: 'listening', title: 'Listening', icon: '🎧', sections: ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6', 'Audio & scripts', 'Answer keys'] },
  { key: 'vocabulary', title: "Lug'at va grammatika", icon: '📘', sections: ['Topic word lists', 'Grammar notes'] },
  { key: 'exam', title: 'Imtihon haqida', icon: 'ℹ️', sections: ['Exam format', 'Scoring', 'Exam day tips'] }
];

export const MATERIAL_LEVELS = ['all', 'B1', 'B2', 'C1'];

export default { MATERIAL_FOLDERS, MATERIAL_LEVELS };
