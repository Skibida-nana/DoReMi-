export interface UserGuideSectionBlock {
  id: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  note?: string;
}

export interface UserGuideChapter {
  id: string;
  number: string;
  title: string;
  summary: string;
  keywords: string[];
  sections: UserGuideSectionBlock[];
}

export interface UserGuideSearchMatch {
  chapter: UserGuideChapter;
  matchedSectionIds: string[];
  score: number;
}
