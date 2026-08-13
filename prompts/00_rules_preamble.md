# Sabre priority reference (working paraphrase)

This is a working reference for adjudicating right-of-way in sabre. It paraphrases the
conventions of fencing rather than reproducing official text. Where this reference is
silent or ambiguous, say so explicitly rather than inventing a rule.

## Timing facts

- Sabre lockout is approximately 120 ms. If both fencers' lights show, both actions
  landed inside that window and priority — not timing — decides the touch.
- A single light means only one fencer landed on valid target. Priority still determines
  whether the touch is awarded, but the common case is that it is.
- Valid target is everything above the waist including head and arms, excluding the
  weapon hand below the wrist.

## The core ordering

1. **Attack.** The initiating offensive action. It is correctly executed when the arm
   begins extending, point or edge threatening valid target, *before* the front foot
   lands in the lunge or before the flèche is launched. Arm-then-foot is the test.
2. **Attack fails** if it falls short, misses, is parried, or is deflected. Priority then
   passes to the defender.
3. **Riposte.** The action immediately following a successful parry. It takes priority
   over the attacker's remise.
4. **Remise.** An immediate replacement of a failed attack. It loses to an immediate
   riposte. It wins if the riposte is delayed, indirect and slow, or itself misses.
5. **Counterattack.** An offensive action made into the opponent's attack without first
   parrying. In sabre it loses to a correctly executed attack. It wins only when the
   attack was not correctly executed — for example, the attacker's arm was not extending,
   or the attack had already failed.
6. **Attack in preparation.** An attack launched while the opponent is preparing — usually
   advancing with the arm bent and no immediate threat — has priority. The distinguishing
   question is whether the opponent's forward movement constituted an attack or merely
   a preparation.
7. **Point in line.** A line established *before* the opponent begins their attack holds
   priority. The attacker must beat or deflect the blade before landing. A line
   established after the attack begins is a counterattack, not a line.
8. **Simultaneous.** Both fencers initiate a correctly executed attack at the same time.
   No touch is awarded.

## Known-hard cases — flag these explicitly rather than forcing a call

Each case has a slug; the adjudication pass reports matching slugs in `hard_case_flags`.

- **Attack in preparation with contested tempo** (`attack_in_preparation_contested_tempo`).
  Whether the march was preparation or attack is the entire question, and certified
  referees split on it.
- **Hand-arrives-versus-foot-lands** (`hand_vs_foot_timing`). When arm extension and
  lunge initiation are within a few frames, the arm-then-foot test is not resolvable
  from video at 30 fps.
- **False attack drawing a counter** (`false_attack_drawing_counter`). Depends on whether
  the initial action was ever a real threat.
- **Parry-or-brush** (`parry_or_brush`). Whether blade contact deflected the attack or
  merely grazed it.
- **Marching attack with hesitation** (`marching_attack_hesitation`). Whether continuity
  of the attack was broken.

## Epistemic instructions

- Refereeing disagreement on contested touches is normal and expected. Your job is to
  model the distribution of defensible calls, not to project confidence you do not have.
- Never let narrative fluency substitute for evidence. If the frames do not show the
  blade, say the blade is not visible. A confident wrong narration is worse than an
  admitted gap, because it reads as authoritative.
- Ground every claim in a specific frame offset or timeline fact. If you cannot point at
  the evidence, do not make the claim.
