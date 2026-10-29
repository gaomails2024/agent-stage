import type { CardVariant } from './AgentCard';
import type { AgentInstance } from '../domain/agent';
import type { CharacterConfig } from '../config/types';

function motionBase(asset: string): { dir: string; name: string } | null {
  const m = asset.match(/^(.*\/)([^/]+)\.(png|webp|jpe?g)$/i);
  return m ? { dir: m[1]!, name: m[2]! } : null;
}

/** Decorative motion beside a still: portrait.png → portrait-motion.webm; stage.png → stage-motion.webm */
export function motionSrcFor(
  asset: string | null,
  status: string,
  variant: CardVariant,
): string | null {
  // Seat + stage: motion in every live status. Offline stays static.
  if (!asset || status === 'offline') return null;
  if (variant !== 'seat' && variant !== 'stage') return null;
  const base = motionBase(asset);
  return base ? `${base.dir}${base.name}-motion.webm` : null;
}

/** Stage-only alternative art: stage-motion.webm → se.stage-motion.webm */
export function seMotionSrcFor(asset: string | null): string | null {
  if (!asset) return null;
  const base = motionBase(asset);
  return base ? `${base.dir}se.${base.name}-motion.webm` : null;
}

export function clampSeStagePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `roll` is a percentage in [0, 100). Exposed for deterministic tests. */
export function shouldUseSeStage(percent: number, roll: number): boolean {
  return roll < clampSeStagePercent(percent);
}

export type StageMotionFlavor = 'normal' | 'se';

export interface StageMotionChoice {
  agent: AgentInstance;
  character: CharacterConfig;
  flavor: StageMotionFlavor;
  /** Stage still used beneath the clip. */
  stillSrc: string;
  /** WebM clip to play for this choice. */
  motionSrc: string;
}

/**
 * Every stage entrance a roster agent can show: one normal + one alternative
 * clip per character. The order is stable so callers/tests can reason about
 * the uniform draw.
 */
export function stageMotionChoices(
  agents: readonly AgentInstance[],
  charactersById: ReadonlyMap<string, CharacterConfig>,
): StageMotionChoice[] {
  const choices: StageMotionChoice[] = [];
  for (const agent of agents) {
    const character = charactersById.get(agent.characterId);
    if (!character) continue;
    const stillSrc = character.stagePortraitPath || character.portraitPath;
    if (!stillSrc) continue;
    const normalSrc = motionSrcFor(stillSrc, 'running', 'stage');
    if (!normalSrc) continue;
    choices.push({ agent, character, flavor: 'normal', stillSrc, motionSrc: normalSrc });
    const seSrc = seMotionSrcFor(stillSrc);
    if (seSrc) {
      choices.push({ agent, character, flavor: 'se', stillSrc, motionSrc: seSrc });
    }
  }
  return choices;
}

/** Normal-version-only stage entrances: one per roster agent. */
export function normalStageMotionChoices(
  agents: readonly AgentInstance[],
  charactersById: ReadonlyMap<string, CharacterConfig>,
): StageMotionChoice[] {
  return stageMotionChoices(agents, charactersById).filter(
    (choice) => choice.flavor === 'normal',
  );
}

/** Alternative (SE) stage entrances only: one per character that has SE art. */
export function seStageMotionChoices(
  agents: readonly AgentInstance[],
  charactersById: ReadonlyMap<string, CharacterConfig>,
): StageMotionChoice[] {
  return stageMotionChoices(agents, charactersById).filter(
    (choice) => choice.flavor === 'se',
  );
}

function pickRandomChoice(
  choices: readonly StageMotionChoice[],
  random: () => number,
): StageMotionChoice | null {
  if (choices.length === 0) return null;
  const roll = random();
  const normalized = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999) : 0;
  return choices[Math.floor(normalized * choices.length)] ?? choices[0]!;
}

/** Uniformly pick one of the supplied choices. `random` is injected for tests. */
export function pickRandomStageMotion(
  agents: readonly AgentInstance[],
  charactersById: ReadonlyMap<string, CharacterConfig>,
  random: () => number = Math.random,
): StageMotionChoice | null {
  return pickRandomChoice(stageMotionChoices(agents, charactersById), random);
}

/** Pick one of the 10 normal-version stage entrances. */
export function pickRandomNormalStageMotion(
  agents: readonly AgentInstance[],
  charactersById: ReadonlyMap<string, CharacterConfig>,
  random: () => number = Math.random,
): StageMotionChoice | null {
  return pickRandomChoice(normalStageMotionChoices(agents, charactersById), random);
}

/** Pick one of the alternative (SE) stage entrances. */
export function pickRandomSeStageMotion(
  agents: readonly AgentInstance[],
  charactersById: ReadonlyMap<string, CharacterConfig>,
  random: () => number = Math.random,
): StageMotionChoice | null {
  return pickRandomChoice(seStageMotionChoices(agents, charactersById), random);
}
