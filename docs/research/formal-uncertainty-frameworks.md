# Formal Frameworks for Epistemic Humility in Distributed Verification Systems

> **Date:** 2026-04-01 | **Status:** Research | **Audience:** Protocol designers, architects
> **Relevance:** Informs ECP epistemic semantics (ecp-spec.md ss4), confidence model evolution, and multi-engine verdict composition.

---

## 1. The Problem: Epistemic Humility Deficit in Protocol Design

AI systems suffer from a fundamental inability to represent what they do not know. This "Epistemic Humility Deficit" (theory.md ss2.1) manifests at the protocol level as a collapse of distinct epistemic states into a single scalar:

- "50% confident with strong evidence on both sides" and "no information at all" both map to confidence = 0.5.
- A chain of three 90%-confident inferences yields 72.9% under independence -- but the real degradation depends on shared evidence, temporal staleness, and trust topology.
- Two "independent" oracles sharing an upstream dependency are not independent at all.

Vinyan's ECP already addresses this better than most protocols (four epistemic types, tiered trust, temporal decay, falsifiability conditions). But the current scalar confidence model has known theoretical limitations. This document surveys formal frameworks that could strengthen the protocol's epistemic foundations.

---

## 2. Formal Frameworks for Representing Uncertainty

### 2.1 Bayesian Probability

The dominant framework: uncertainty is a single probability P(H|E) updated via Bayes' theorem.

**Formalism:**
```
P(H|E) = P(E|H) * P(H) / P(E)
```

**Strengths:** Mathematically elegant. Composable via the chain rule. Well-understood computational methods (MCMC, variational inference). The entire machine learning field builds on it.

**Weaknesses for protocol design:**
- *Requires prior specification.* What is the prior for "does this TypeScript file type-check"? Priors are often arbitrary, and the protocol cannot mandate how engines choose them.
- *Forces point estimates.* A single number conflates "I have strong evidence for 50%" with "I have no idea." Both are P = 0.5.
- *Cannot represent ignorance.* The framework has no primitive for "I don't know" -- every hypothesis must receive a probability, even when no evidence exists.
- *Assumes a closed world.* The hypothesis space must be enumerated in advance. Unknown unknowns have probability zero by construction.

**ECP relevance:** The current `confidence: number` field is implicitly Bayesian. This is adequate for deterministic oracles (confidence = 1.0) but insufficient for the probabilistic and speculative tiers where the *quality* of evidence matters as much as the *degree* of belief.

**Assessment matrix:**

| Criterion | Rating |
|:----------|:-------|
| Represent "I don't know" | No -- must assign a number |
| Known unknowns | Poorly -- via low confidence, indistinguishable from weak evidence |
| Unknown unknowns | Cannot -- closed world assumption |
| Computational complexity | O(n) for conjugate priors, expensive for general models |
| Composability | Excellent under independence; fragile when violated |

### 2.2 Dempster-Shafer Theory (DST)

Belief functions generalize probability by allowing mass to be assigned to *sets* of hypotheses, not just singletons. The key innovation is a three-valued epistemic state: belief (Bel), plausibility (Pl), and an explicit uncertainty gap.

**Formalism:**
- A *mass function* m: 2^Theta -> [0,1] assigns mass to subsets of the frame of discernment Theta.
- m(empty set) = 0 (in closed-world DST), sum of all m(A) = 1.
- Bel(A) = sum of m(B) for all B subset of A -- minimum confidence supported by direct evidence.
- Pl(A) = 1 - Bel(not-A) -- maximum confidence if all ambiguous evidence resolves favorably.
- The *uncertainty gap* = Pl(A) - Bel(A) quantifies ignorance.

**Combination (Dempster's Rule):**
```
m_combined(A) = (1 / (1-K)) * sum_{B intersect C = A} m1(B) * m2(C)
```
where K = sum_{B intersect C = empty} m1(B) * m2(C) measures conflict between sources.

**Strengths:**
- *Explicitly represents ignorance.* Mass assigned to Theta (the full frame) means "I have no idea." This is fundamentally different from uniform probability.
- *Quantifies conflict.* The normalization constant K reveals when sources disagree, rather than silently averaging disagreements away.
- *Natural for multi-oracle composition.* Each oracle contributes a mass function; Dempster's rule fuses them.

**Weaknesses:**
- *Zadeh's paradox.* When two highly confident but conflicting sources are combined, Dempster's rule can produce counterintuitive results (assigning all mass to a low-prior hypothesis). This is directly relevant to oracle contradiction scenarios.
- *Assumes source independence.* Two oracles sharing an upstream AST parse are not independent; applying Dempster's rule as if they were inflates apparent confidence.
- *Computational cost.* Exact computation is exponential in |Theta| for general mass functions. For binary hypotheses (verified/not-verified), this is manageable.

**ECP relevance:** The ECP spec ss4.2 already defines an optional `BeliefInterval { belief, plausibility }` extension. DST provides the theoretical foundation for this -- the uncertainty gap (plausibility - belief) is precisely what distinguishes "confident with evidence" from "no information." The conflict constant K maps naturally to the existing `type: "contradictory"` state.

**Assessment matrix:**

| Criterion | Rating |
|:----------|:-------|
| Represent "I don't know" | Yes -- m(Theta) = 1 is vacuous belief |
| Known unknowns | Yes -- uncertainty gap quantifies it |
| Unknown unknowns | Partially -- via open-world TBM extension (ss2.8) |
| Computational complexity | O(2^n) general, O(1) for binary frames |
| Composability | Good with Dempster's rule; fails with dependent sources |

### 2.3 Subjective Logic (Josang)

Extends DST with an explicit opinion representation: a tuple omega = (b, d, u, a) where b = belief, d = disbelief, u = uncertainty mass (b + d + u = 1), and a = base rate (prior probability).

**Key properties:**
- The *opinion triangle* provides geometric intuition: a point inside an equilateral triangle represents (b, d, u), with vertices at "certain true," "certain false," and "complete ignorance."
- *Projected probability:* P(H) = b + a * u -- uncertainty is distributed according to the prior. When u = 0, this reduces to standard probability. When u = 1, it reduces to the prior.
- *Multiple fusion operators:* cumulative fusion (for independent sources), averaging fusion (for dependent sources), weighted fusion, consensus fusion, and constraint fusion. The choice of operator depends on the epistemic relationship between sources.
- *Vacuous opinion:* omega = (0, 0, 1, a) explicitly represents "no evidence." This is the neutral element for cumulative fusion -- adding a vacuous opinion changes nothing.

**Strengths for protocol design:**
- *Compositional.* Multiple fusion operators handle different independence assumptions. This directly addresses the oracle composition problem (ss4).
- *Explicit uncertainty dimension.* Unlike Bayesian probability, a source can declare "I have not examined this" as distinct from "I examined it and the evidence is ambiguous."
- *Computationally cheap.* All operations are closed-form arithmetic on 4-tuples. No sampling, no matrix operations.
- *Backwards-compatible with probability.* Setting u = 0 recovers standard probability; setting u = 1 recovers complete ignorance. Existing confidence scalars can be losslessly embedded.

**Weaknesses:**
- *Base rate selection* remains a challenge -- the `a` parameter influences projected probability but is often unknown.
- *Binary frame limitation* for the basic model. Multinomial extensions (Dirichlet opinions) exist but add complexity.
- *Less widely adopted* than Bayesian methods; fewer implementations and tools.

**ECP relevance:** Subjective Logic is the strongest candidate for ECP's confidence model. An oracle verdict could carry omega = (b, d, u, a) instead of -- or in addition to -- a scalar confidence. The projected probability P = b + a*u maintains backward compatibility with the current confidence field. The uncertainty mass u directly answers "how much evidence was actually examined?" and the fusion operators provide principled verdict aggregation.

**Assessment matrix:**

| Criterion | Rating |
|:----------|:-------|
| Represent "I don't know" | Yes -- (0, 0, 1, a) is vacuous |
| Known unknowns | Yes -- u explicitly quantifies |
| Unknown unknowns | Partially -- via base rate sensitivity |
| Computational complexity | O(1) per operation |
| Composability | Excellent -- multiple fusion operators for different scenarios |

### 2.4 Imprecise Probabilities and Credal Sets

Rather than a single probability distribution, the agent maintains a *set* of distributions (a credal set) consistent with available evidence.

**Formalism:**
- A credal set C is a convex set of probability distributions over Theta.
- Lower probability: P_lower(A) = min_{P in C} P(A).
- Upper probability: P_upper(A) = max_{P in C} P(A).
- The interval [P_lower, P_upper] encodes both the point estimate and the *imprecision* due to limited evidence.

**Strengths:**
- *Rigorous treatment of incomplete information.* The size of the credal set shrinks as evidence accumulates. Complete ignorance = the full probability simplex. Perfect knowledge = a singleton.
- *Separates aleatoric from epistemic uncertainty.* Recent work (Caprio et al., 2024; Wang et al., 2025) demonstrates superior performance over Bayesian and ensemble methods in out-of-distribution detection.
- *No arbitrary priors.* The credal set includes all distributions consistent with the evidence, avoiding the need to pick a single prior.

**Weaknesses:**
- *Computational cost.* Maintaining and propagating credal sets is expensive -- decision problems become intractable for large hypothesis spaces.
- *Decision-making is harder.* Standard expected utility maximization does not directly apply; alternatives (Gamma-maximin, E-admissibility) are more complex.
- *Communication overhead.* Transmitting a set of distributions over the wire is heavier than a scalar.

**ECP relevance:** Full credal sets are too expensive for real-time oracle verdicts. However, the *interval* representation [P_lower, P_upper] aligns exactly with the DST belief interval [Bel, Pl]. The ECP `BeliefInterval` extension already captures this. The practical takeaway from Sale et al. (2023) is narrower than a universal scalar metric: credal-set volume behaves sensibly mainly in binary settings, while higher-dimensional settings require more caution. For ECP, interval bounds are the more robust protocol primitive.

### 2.5 Possibility Theory

Dual measures of *necessity* (N) and *possibility* (Pi) where N(A) + Pi(not-A) = 1.

- Pi(A) = 1 means A is fully consistent with available knowledge.
- N(A) = 1 means A is certainly true.
- Uncertainty = Pi(A) - N(A).

Useful for modeling *vagueness* and *incomplete information* rather than randomness. Less suited than DST for multi-source composition because it lacks natural fusion operators. Primarily relevant when uncertainty stems from imprecise language rather than conflicting evidence.

### 2.6 Fuzzy Logic

Degrees of truth in [0, 1] for propositions. Addresses *vagueness* ("is this function complex?") rather than *uncertainty* ("is this function correct?"). Not directly applicable to epistemic humility -- a function either type-checks or does not. Fuzzy logic is useful for soft quality metrics (complexity scores, readability indices) but should not be conflated with confidence in factual claims.

### 2.7 Info-Gap Decision Theory (Ben-Haim)

A non-probabilistic approach to decision-making under *severe* uncertainty -- when you cannot even specify the probability space.

**Core concept:** For a given decision d and uncertainty model U(alpha, u_hat) = {u : ||u - u_hat|| <= alpha}, find the maximum alpha (horizon of uncertainty) at which the system still satisfies performance requirements. This alpha is the *robustness* of decision d.

**Protocol relevance:** Info-Gap thinking maps to ECP's risk routing. At L0 (Reflex), the system tolerates zero uncertainty (hash-only verify). At L3 (Deliberative), it tolerates maximum uncertainty by deploying all oracles plus shadow execution. The robustness function alpha(d) is analogous to risk score thresholds -- "how wrong can the input be before this routing level fails?"

**Criticism:** Info-Gap has been criticized as a reformulation of local minimax (radius of stability) rather than a genuinely new theory. It measures robustness in the *neighborhood* of an initial estimate, not globally. For ECP, this local property is actually a feature -- oracle verdicts should be robust to small perturbations in the verified code, not to arbitrary rewrites.

### 2.8 Transferable Belief Model (Smets)

Smets' TBM extends DST with two key innovations:

1. **Open-world assumption.** m(empty set) >= 0 is allowed, representing belief in outcomes *outside* the frame of discernment. This is crucial for handling unknown unknowns -- the mass assigned to the empty set quantifies "something I haven't even considered might be happening."

2. **Two-level model.** Beliefs are maintained at a *credal level* (belief functions, uncommitted) and translated to a *pignistic level* (probabilities, for decision-making) only when a decision is required. This separation mirrors ECP's distinction between verdict confidence (credal) and gate allow/block decisions (pignistic).

**ECP relevance:** The open-world assumption is directly applicable. When an oracle returns `type: "unknown"`, it can be interpreted analogously as assigning mass to the empty set -- acknowledging that the true answer may lie outside what it can evaluate. The TBM formalizes this as a first-class concept rather than an error state.

---

## 3. Trust and Confidence in Distributed Protocols

### 3.1 PGP Web of Trust

Confidence degrades with distance: if A trusts B, and B trusts C, A's trust in C is lower than A's trust in B. The *trust depth* parameter controls maximum transitive distance. Key insight for ECP: **remote oracle verdicts (A2A) should degrade not just by transport but by hop count in the trust graph.**

### 3.2 Certificate Transparency (CT)

CT handles conflicting identity claims through *append-only logs* and *monitors* that cross-check assertions. Applied to ECP: verdict provenance should be immutable (content-addressed, already implemented via SHA-256 hashes), and conflicting verdicts should be surfaced rather than silently resolved. The existing `type: "contradictory"` state + conflict resolver implements this pattern.

### 3.3 Byzantine Fault Tolerance

BFT provides safety guarantees when up to f of 3f+1 nodes are arbitrarily faulty. The key protocol insight is *quorum intersection* -- any two quorums share at least one honest node. Applied to ECP: for critical decisions (L2-L3), require verdicts from at least 2f+1 oracles where f is the number of potentially unreliable engines. The current conflict resolver's 5-step algorithm is a pragmatic approximation of this -- tier ranking acts as a trust-weighted quorum.

A 2025 paper (deVadoss, 2025) explicitly proposes BFT for AI safety: using multiple independent AI models as "nodes" where consensus among a supermajority is required before accepting an output. This is directionally similar to Vinyan's oracle gate, but not identical: the current system uses deterministic conflict resolution and trust-tier ordering rather than literal BFT quorum consensus.

### 3.4 Verifiable Credentials (W3C)

The VC model attaches *evidence* to *claims* with *selective disclosure*. The issuer, holder, and verifier roles map to ECP's generator, orchestrator, and oracle roles. Key innovation: credentials carry machine-verifiable proofs of the claim's basis. ECP's `evidence[]` and `falsifiable_by` fields implement a simplified version of this pattern.

---

## 4. The Composition Problem

The central challenge: given verdicts from multiple oracles with individual confidence levels, what is the combined confidence?

### 4.1 Independence and Its Violations

If oracle A reports confidence c_A and oracle B reports c_B, the naive composition for "both are correct" is:

```
c_combined = c_A * c_B    (under independence)
```

This assumes A and B share no evidence. In practice, oracles routinely share upstream data:
- AST and Type oracles both parse the same file.
- Dependency and Test oracles both rely on the import graph.
- Two remote A2A oracles may consult the same upstream LLM.

**The common evidence problem:** When sources share upstream data, their errors are correlated. Multiplying their confidences *overestimates* the combined confidence. The correct treatment requires modeling the dependency structure -- which is generally unknown.

### 4.2 Opinion Pooling Methods

| Method | Formula | Properties | When to Use |
|:-------|:--------|:-----------|:------------|
| **Linear pool** | P_pool = sum(w_i * P_i) | Preserves calibration, updates are conservative | Dependent sources with unknown correlation |
| **Logarithmic pool** | P_pool proportional to product(P_i^w_i) | Externally Bayesian, treats confident forecasts seriously | Independent sources with known calibration |
| **Geometric mean of odds** | Odds_pool = product(O_i^w_i) | Equivalent to logarithmic pool, robust to extremes | Forecasting, when extremes should be dampened |
| **Subjective Logic fusion** | Multiple operators per ss2.3 | Handles independence/dependence explicitly | When epistemic relationship between sources is known |

**Key finding:** Linear pooling is more robust when independence is uncertain. It is conservative -- it cannot produce a combined confidence higher than the maximum individual confidence. Logarithmic pooling is more aggressive and can produce results more extreme than any individual source.

**ECP recommendation:** Use *linear pooling with tier-weighted coefficients* as the default aggregation when oracle independence is unknown. This aligns with the existing quality-score weighted average. When oracles are known to be independent (different tiers examining different evidence), logarithmic pooling is appropriate and yields a tighter combined estimate.

### 4.3 Uncertainty Propagation in Inference Chains

When conclusions are chained (verdict A feeds into hypothesis B), uncertainty compounds. For n steps with individual confidence c:

```
c_chain = c^n                    (independent steps, multiplicative)
c_chain = c - n * epsilon        (additive error per step, linear degradation)
```

For a 5-step inference chain at 95% per step: multiplicative gives 77.4%, additive (epsilon=0.02) gives 85%. The multiplicative model is pessimistic but safe; the additive model is appropriate when each step's error is bounded and independent of accumulated state.

**Protocol implication:** ECP should track *inference depth* -- how many reasoning steps separate the original evidence from the current verdict. The `evidence_chain` length serves as a proxy. Each additional inference step should apply a configurable decay factor, distinct from temporal decay.

---

## 5. Open Problems

### 5.1 The Reference Class Problem

To calibrate oracle confidence, we need a reference population. But which one? A type checker's accuracy on TypeScript files is different from its accuracy on TypeScript-with-decorators files. The choice of reference class changes the calibration. ECP's current approach -- per-oracle historical accuracy (conflict-resolver.ts step 4) -- is pragmatic but requires careful attention to population drift.

### 5.2 Deep Uncertainty

When we cannot even specify the hypothesis space (e.g., a novel vulnerability class that no oracle is designed to detect), all formal frameworks fail. The only honest protocol response is to acknowledge the limitation. ECP's `type: "unknown"` serves this purpose, but the system cannot *know* when it is in this regime. The TBM's open-world mass m(empty set) provides a formal hook, but quantifying it remains an open problem.

### 5.3 Adversarial Uncertainty

If an attacker can influence oracle inputs (prompt injection, malicious dependencies), confidence values become unreliable. The guardrail layer (guardrails/index.ts) provides first-line defense, but formally characterizing adversarial robustness of the confidence model is unsolved. BFT provides a partial answer for the multi-oracle case: if fewer than 1/3 of oracles are compromised, the system maintains safety.

### 5.4 Recursive Uncertainty

Uncertainty about uncertainty: how confident are we in our confidence model? This leads to infinite regress. Practical resolution: fix a meta-uncertainty level (e.g., "our confidence model is calibrated to within +/- 0.1") and treat this as a system parameter, not a dynamically computed value. The trust tier system (deterministic/heuristic/probabilistic/speculative) provides coarse-grained meta-uncertainty.

### 5.5 Model Uncertainty vs. Parameter Uncertainty

An oracle's confidence may be wrong because the underlying model is wrong (model uncertainty) or because the model is right but imprecisely parameterized (parameter uncertainty). The distinction matters for calibration: parameter uncertainty shrinks with more data; model uncertainty requires structural change. ECP's tier system partially captures this -- deterministic oracles have zero model uncertainty (compiler is correct by definition), while probabilistic oracles have both.

---

## 6. Framework Comparison Matrix

| Framework | "I don't know" | Known Unknowns | Unknown Unknowns | Complexity | Composability | ECP Fit |
|:----------|:--------------:|:---------------:|:------------------:|:----------:|:-------------:|:-------:|
| Bayesian Probability | No | Weak | No | Medium | Excellent | Current baseline |
| Dempster-Shafer | Yes | Yes | Partial (TBM) | High (general) | Good | BeliefInterval extension |
| **Subjective Logic** | **Yes** | **Yes** | **Partial** | **Low** | **Excellent** | **Best candidate for v2** |
| Imprecise Probabilities | Yes | Yes | Yes | Very High | Complex | Too expensive for real-time |
| Possibility Theory | Yes | Yes | No | Low | Weak | Niche (vagueness only) |
| Fuzzy Logic | No | No | No | Low | Good | Quality metrics only |
| Info-Gap | N/A | N/A | Yes (by design) | Medium | N/A | Risk routing model |
| TBM (Smets) | Yes | Yes | Yes | High | Good | Open-world extension |

---

## 7. Protocol Design Principles

Distilling the formal analysis into concrete protocol features for ECP evolution:

### P1: Mandatory Uncertainty Gap (from DST/Subjective Logic)

**Current state:** Scalar confidence in [0, 1]. Optional `BeliefInterval { belief, plausibility }`.

**Recommendation:** Promote `BeliefInterval` to a recommended (Level 1+) field. The uncertainty gap (plausibility - belief) is the single most informative number missing from the current protocol. It distinguishes "confident with evidence" (gap ~ 0) from "no evidence examined" (gap ~ 1). Engines that cannot compute it should set belief = plausibility = confidence (zero gap, backward compatible).

### P2: Explicit Vacuity Detection (from Subjective Logic)

**Principle:** A verdict with no evidence should be distinguishable from a verdict with balanced evidence. The vacuous opinion omega = (0, 0, 1, a) is the formal representation of "I have not examined this at all."

**Implementation:** Add `vacuous: boolean` flag or derive it from uncertainty mass u > 0.95. The Orchestrator should never count vacuous verdicts as evidence for or against -- they should be treated as abstentions in the aggregation.

### P3: Inference Depth Tracking (from Uncertainty Propagation)

**Principle:** Confidence degrades along inference chains. A fact derived from three intermediate facts has lower effective confidence than a directly observed fact.

**Implementation:** Add `inference_depth: number` to verdicts and facts. Apply multiplicative decay: `effective_confidence = confidence * decay^inference_depth` where decay is a configurable parameter (default 0.95). The World Graph already tracks evidence provenance; inference depth can be computed from the evidence chain length.

### P4: Source Independence Declaration (from the Composition Problem)

**Principle:** Verdict aggregation must know whether sources share upstream evidence. Currently, the gate assumes all oracles are independent -- this overestimates combined confidence.

**Implementation:** Oracle registration should declare `shared_dependencies: string[]` (e.g., ["ast-parse", "file-read"]). The conflict resolver can then use linear pooling (conservative) for oracles with shared dependencies and logarithmic pooling (aggressive) for truly independent oracles.

### P5: Conflict Quantification (from DST)

**Current state:** The conflict resolver reports whether contradiction exists and which oracle won. It does not quantify the *degree* of conflict.

**Recommendation:** Compute DST's conflict constant K when aggregating verdicts. When K > 0.5 (more than half the joint evidence is conflicting), the result should be flagged as unreliable regardless of which oracle "wins." High K indicates the oracles are operating on incompatible assumptions -- a deeper issue than simple disagreement.

### P6: Open-World Mass (from TBM)

**Principle:** Allow the protocol to represent "the answer may be outside what any oracle can evaluate." This is the formal treatment of unknown unknowns.

**Implementation:** Add optional `open_world_mass: number` to verdicts. An oracle that encounters code patterns it was not designed to analyze (e.g., a TypeScript oracle encountering embedded SQL) should set open_world_mass > 0 rather than guessing. The Orchestrator can aggregate open_world_mass across oracles -- if the total exceeds a threshold, it signals that the hypothesis falls outside the system's competence boundary.

### P7: Temporal-Epistemic Coupling (from temporal validity + uncertainty)

**Current state:** Temporal decay (linear/step/none) is applied independently of evidence quality.

**Recommendation:** Couple decay rate to evidence tier. Deterministic verdicts (compiler output) decay slower -- the file hasn't changed, so the verdict is still valid. Heuristic verdicts decay faster -- the surrounding context may have changed semantics. Probabilistic verdicts decay fastest -- statistical patterns shift with codebase evolution.

**Suggested decay rates:**
| Tier | Half-life multiplier |
|:-----|---------------------:|
| deterministic | 4x base |
| heuristic | 2x base |
| probabilistic | 1x base |
| speculative | 0.5x base |

### P8: Conservative Default Aggregation (from Opinion Pooling)

**Principle:** When oracle independence is unknown (the common case), use the aggregation method that cannot overestimate confidence.

**Implementation:** Default to linear pooling with tier weights. The current quality-score weighted average approximates this. The key invariant: **combined confidence must never exceed the maximum individual confidence** unless the aggregation method explicitly accounts for independence (logarithmic pooling, Dempster's rule).

---

## 8. Relationship to Existing ECP Implementation

| ECP Feature | Formal Foundation | Status | Gap |
|:------------|:-----------------|:-------|:----|
| `confidence: number` | Bayesian point estimate | Implemented | Conflates evidence quality with degree of belief |
| `type: "unknown"` | DST vacuous mass, SL vacuous opinion | Implemented | No quantification of *how* unknown |
| `type: "contradictory"` | DST conflict constant K | Implemented | K not computed numerically |
| `BeliefInterval` | DST Bel/Pl, IP lower/upper | Specified (ss4.2) | Not yet implemented in oracle runners |
| Trust tier clamping | SL base rate, DST evidence weighting | Implemented | No shared-dependency awareness |
| Temporal decay | Possibility theory necessity decay | Implemented | Not coupled to evidence tier |
| Falsifiability | Popperian epistemology | Implemented | No automated re-verification triggers |
| Conflict resolution | BFT quorum, DST tier ranking | Implemented (5-step) | No quantitative conflict measure |
| Inference depth | Uncertainty propagation theory | Not implemented | No tracking of reasoning chain length |
| Open-world mass | TBM (Smets) | Not implemented | Unknown unknowns not formally representable |

---

## 9. Implementation Priority

Based on formal rigor, implementation cost, and backward compatibility:

1. **P1 (Belief Intervals)** -- Highest impact, already specified. Implement in oracle runners.
2. **P5 (Conflict Quantification)** -- Low cost, high diagnostic value. Add K computation to conflict resolver.
3. **P3 (Inference Depth)** -- Medium cost, critical for multi-hop reasoning in Phase 3+.
4. **P8 (Conservative Aggregation)** -- Audit current aggregation; ensure it satisfies the linear pooling invariant.
5. **P4 (Source Independence)** -- Medium cost, requires oracle registration schema change.
6. **P7 (Temporal-Epistemic Coupling)** -- Low cost, improves cache hit quality.
7. **P2 (Vacuity Detection)** -- Low cost, improves aggregation accuracy.
8. **P6 (Open-World Mass)** -- Highest formal value, lowest practical urgency. Phase 5+ when multi-instance coordination creates genuine unknown-unknown scenarios.

---

## References

### Formal Frameworks
- Dempster, A. P. (1967). Upper and lower probabilities induced by a multivalued mapping. *Annals of Mathematical Statistics*, 38(2), 325-339.
- Shafer, G. (1976). *A Mathematical Theory of Evidence*. Princeton University Press.
- Josang, A. (2016). *Subjective Logic: A Formalism for Reasoning Under Uncertainty*. Springer.
- Josang, A., et al. (2018). Multi-Source Fusion Operations in Subjective Logic. *Information Fusion*, 48, 80-97.
- Smets, P., & Kennes, R. (1994). The Transferable Belief Model. *Artificial Intelligence*, 66(2), 191-234.
- Walley, P. (1991). *Statistical Reasoning with Imprecise Probabilities*. Chapman and Hall.
- Ben-Haim, Y. (2006). *Info-Gap Decision Theory: Decisions Under Severe Uncertainty*. Academic Press.
- Zadeh, L. A. (1978). Fuzzy Sets as a Basis for a Theory of Possibility. *Fuzzy Sets and Systems*, 1(1), 3-28.

### Trust and Distributed Systems
- Lamport, L., Shostak, R., & Pease, M. (1982). The Byzantine Generals Problem. *ACM TOPLAS*, 4(3), 382-401.
- deVadoss, J. (2025). A Byzantine Fault Tolerance Approach towards AI Safety. arXiv:2504.14668.
- Amiri, M. J., et al. (2024). The Bedrock of Byzantine Fault Tolerance: A Unified Platform for BFT Protocol Design and Implementation. *NSDI 2024*.

### Uncertainty in AI Systems
- Mukherjee, T., et al. (2026). Credal Concept Bottleneck Models: Structural Separation of Epistemic and Aleatoric Uncertainty. arXiv:2602.11219.
- Manchingal, S. K. & Cuzzolin, F. (2025). Position: Epistemic Artificial Intelligence is Essential for Machine Learning Models to 'Know When They Do Not Know'. arXiv:2505.04950.
- Sale, Y., et al. (2023). Is the Volume of a Credal Set a Good Measure for Epistemic Uncertainty? arXiv:2306.09586.
- Kadavath, S., et al. (2022). Language Models (Mostly) Know What They Know. arXiv:2207.05221.
- Xiong, M., et al. (2024). Can LLMs Express Their Uncertainty? An Empirical Evaluation of Confidence Elicitation in LLMs. *ICLR 2024*.

### Opinion Pooling
- Dietrich, F., & List, C. (2016). Probabilistic Opinion Pooling. In *Oxford Handbook of Probability and Philosophy*.
- Genest, C., & Zidek, J. V. (1986). Combining Probability Distributions: A Critique and an Annotated Bibliography. *Statistical Science*, 1(1), 114-135.

### Dempster-Shafer Recent Work
- Li, Y., et al. (2025). Measure-based uncertainty with Dempster-Shafer structure. *Science China Information Sciences*.
- Aslam, M. S., et al. (2024). Dempster-Shafer theory-based information fusion for natural disaster emergency management: A systematic literature review. *Information Fusion*.

Sources:
- [Dempster-Shafer Theory - Wikipedia](https://en.wikipedia.org/wiki/Dempster%E2%80%93Shafer_theory)
- [Multi-Source Fusion in Subjective Logic - Josang et al.](https://www.mn.uio.no/ifi/english/people/aca/josang/publications/jwz2017-fusion.pdf)
- [Multi-Source Fusion Operations in Subjective Logic - arXiv](https://ar5iv.labs.arxiv.org/html/1805.01388)
- [Subjective Logic - Wikipedia](https://en.wikipedia.org/wiki/Subjective_logic)
- [Subjective Logic: A Formalism for Reasoning Under Uncertainty - Josang (Book)](https://books.google.com/books/about/Subjective_Logic.html?id=nqRlDQAAQBAJ)
- [Position: Epistemic AI is Essential - arXiv:2505.04950](https://arxiv.org/html/2505.04950v1)
- [Credal Set Volume as Epistemic Uncertainty Measure - arXiv](https://arxiv.org/html/2306.09586)
- [Quantification of Credal Uncertainty - arXiv:2603.27270](https://arxiv.org/abs/2603.27270)
- [Info-Gap Decision Theory - Wikipedia](https://en.wikipedia.org/wiki/Info-gap_decision_theory)
- [Transferable Belief Model - Wikipedia](https://en.wikipedia.org/wiki/Transferable_belief_model)
- [TBM - Smets and Kennes (PDF)](https://iridia.ulb.ac.be/~psmets/TBM-AIJ.pdf)
- [BFT Approach to AI Safety - arXiv:2504.14668](https://www.arxiv.org/pdf/2504.14668)
- [The Bedrock of BFT - NSDI 2024](https://www.usenix.org/system/files/nsdi24-amiri.pdf)
- [Probabilistic Opinion Pooling - Dietrich & List](https://philarchive.org/archive/DIEPOP)
- [Geometric Mean of Odds for Pooling Forecasts](https://forum.effectivealtruism.org/posts/sMjcjnnpoAQCcedL2/when-pooling-forecasts-use-the-geometric-mean-of-odds)
- [Measure-based Uncertainty with DS Structure - Science China 2025](https://link.springer.com/article/10.1007/s11432-024-4563-x)
- [DS Theory for IoT Uncertainty - MDPI Sensors](https://www.mdpi.com/1424-8220/21/5/1863)
- [Credal Concept Bottleneck Models - arXiv:2602.11219](https://arxiv.org/html/2602.11219)
- [Integral Imprecise Probability Metrics - arXiv:2505.16156](https://arxiv.org/pdf/2505.16156)
