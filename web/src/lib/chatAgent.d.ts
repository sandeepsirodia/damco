import type { Parameter } from '@copilotkit/shared';

export declare const INSTRUCTIONS: string;

export declare const TOOLS: {
  startFeatureSpec: { description: string; parameters: Parameter[] };
  submitFeatureAnswers: { description: string; parameters: Parameter[] };
  pushToGithub: { description: string; parameters: Parameter[] };
};
