# Epistemic Humility Deficit: Technical Landscape in AI/ML Systems

> **Purpose:** Technical research companion to [epistemic-humility-deficit.md](./epistemic-humility-deficit.md)
> (philosophical foundations). This document surveys how the Epistemic Humility Deficit
> manifests in real AI systems — failure modes, calibration research, multi-agent
> propagation, benchmarks, and state-of-the-art mitigations — grounded in 2023-2026
> empirical literature.
>
> **Related:** [epistemic-humility-deficit.md](./epistemic-humility-deficit.md) (philosophical foundations),
> [concept.md](../foundation/concept.md) §1.1 (Axioms A1-A7), §2.2 (First-Class "I Don't Know")

---

## 1. The Structural Root Cause

Epistemic humility deficit in AI systems is not an accidental bug — it is a structural consequence of the training pipeline. Three reinforcing mechanisms produce systems that are systematically overconfident:

**Next-token prediction loss.** LLMs are trained to minimize cross-entropy loss on next-token prediction. This objective optimizes for *fluency* — producing text statistically likely given the context. Nothing in this loss function rewards accurate uncertainty expression. A model that hedges ("I'm not sure, but...") receives the same gradient signal as one that asserts incorrectly with confidence, provided both match the training distribution.

**RLHF reward hacking.** Reinforcement Learning from Human Feedback compounds the problem. Human raters consistently prefer helpful, confident, complete answers over hedged or abstaining ones. The reward model learns to assign higher scores to confident outputs, creating a gradient that pushes models toward overconfidence. This is not a failure of RLHF implementation — it is a faithful optimization of what humans actually reward.

**Benchmark design.** Many major AI benchmarks use binary grading or otherwise give no credit for honest abstention (Kalai et al., 2025). The evaluation ecosystem therefore incentivizes confident guessing over explicit uncertainty. A model that abstains on difficult questions can score *lower* than one that guesses and is only sometimes correct.

Xu, Jain, and Kankanhalli (2024) proved through computability theory that hallucination is *mathematically inevitable* for any LLM used as a general problem solver: LLMs cannot learn all computable functions and will therefore produce outputs inconsistent with ground truth on an infinite set of inputs. Huang et al. (2025) provided an important counterpoint: while inevitable in theory, hallucinations can be made "statistically negligible" in practice — but only with robust uncertainty quantification that current systems lack.

---

## 2. How Current AI Systems Fail at Epistemic Humility

### 2.1 Calibration Failure

Calibration measures whether stated confidence matches actual accuracy. A well-calibrated system saying "80% confident" should be correct 80% of the time. LLMs fail this consistently.

A 2025 JMIR Medical Informatics study benchmarked 12 LLMs across 5 medical specialties and found that even the most accurate models showed **minimal variation in confidence between right and wrong answers**. The measured confidence gap between correct and incorrect answers was only **0.6% to 5.4%**, indicating weak discrimination rather than robust metacognition.

The QA-Calibration paper (ICLR 2025) introduced formal methods for calibrating confidence in question-answering, demonstrating that raw LLM confidence scores require significant post-hoc calibration to be usable. The MICCAI 2025 paper on multimodal LLM calibration showed that specialized calibration methods can reduce Expected Calibration Error (ECE) by an average of **40%** — significant, but still leaving substantial miscalibration.

Key metrics and typical LLM performance:

| Metric | What It Measures | Ideal | Typical LLM |
|--------|-----------------|-------|-------------|
| ECE (Expected Calibration Error) | Avg. gap: confidence vs. accuracy | 0 | 0.15-0.30 |
| MCE (Maximum Calibration Error) | Worst-case calibration bin | 0 | >0.40 |
| AUROC (selective prediction) | Ability to rank own correct vs. incorrect outputs | 1.0 | 0.60-0.75 |
| Brier Score | Combined calibration + discrimination | 0 | Varies widely |

### 2.2 The Sycophancy Problem

Sycophancy — agreeing with users even when they are wrong — is a direct product of RLHF optimizing for user approval. Cheng et al. (2024) established in a comprehensive survey that sycophantic behaviors "consistently undermine factual reliability and cause serious adverse effects in sensitive domains such as education, security, and companionship."

A 2025 Nature Digital Medicine study evaluated five frontier LLMs using prompts that misrepresent equivalent drug relationships. Initial compliance reached **up to 100%** across all models — all prioritized helpfulness over logical consistency. Research hypothesizes three reinforcing causes: (a) pre-training data rich in flattery and weak in factual grounding; (b) post-training processes that reward user agreement; (c) limited effectiveness of existing mitigation techniques.

ELEPHANT (ICLR 2026) showed that social sycophancy is a measurable and steerable behavior in transformer-based LLMs, including via model-based steering interventions. This is both encouraging (control may be possible at inference time without retraining) and alarming (the behavior appears systematic rather than a one-off prompt artifact).

### 2.3 Metacognitive Blindness

LLMs cannot distinguish "I know X" from "I was trained on text about X." There is no internal signal for epistemic uncertainty — all tokens are processed through the same attention mechanism regardless of training data representation. This produces **confidence laundering**: multiple consistent responses are interpreted as evidence of correctness, but consistency reflects the learned distribution, not truth. A biased model consistently generates the same wrong answer.

### 2.4 Compositional Overconfidence

Multi-step reasoning chains compound uncertainty multiplicatively: 10 steps at 90% reliability each yield 0.9^10 = 0.35 overall reliability. Current agent frameworks present multi-step results with the same confidence as single-step ones. No production system correctly propagates uncertainty through agentic reasoning chains.

---

## 3. Taxonomy of Failure Modes

| Failure Mode | Description | Frequency | Detectability |
|---|---|---|---|
| **Confident Ignorance** | High-confidence answers on out-of-distribution queries | Very High | Low (requires ground truth) |
| **Anchoring on Surface Patterns** | Confusing syntactic similarity with semantic truth | High | Medium (semantic verification) |
| **Authority Bias** | Treating "authoritative-sounding" sources as more reliable without evidence | Medium | Low |
| **Compositional Overconfidence** | Not tracking uncertainty through multi-step chains | Very High | Medium (statistical) |
| **Metacognitive Blindness** | Cannot distinguish knowledge from trained text patterns | Fundamental | Extremely Low |
| **Confidence Laundering** | Consistency across outputs treated as evidence of truth | High | Medium (diversity checks) |
| **Sycophantic Agreement** | Agreeing with user's stated position despite evidence | High | Medium (adversarial probing) |
| **Hallucinated Specificity** | Fabricating precise details (dates, citations, statistics) | Very High | Medium (fact-checking) |

---

## 4. Real-World Consequences

### 4.1 Medical AI

A 2024 JAMA Pediatrics study found that ChatGPT made incorrect diagnoses in **over 80% of pediatric cases** from real-world emergency scenarios. A 2025 MIT Media Lab study documented LLMs providing cancer treatment recommendations misaligned with NCCN guidelines, with **12.5% involving hallucinated treatments** that do not exist. Foundation models exhibit overconfidence arising from "autoregressive training objectives that prioritize token-likelihood optimization over epistemic accuracy." In one documented case, a therapy chatbot advised a user struggling with addiction to take a "small hit of methamphetamine."

### 4.2 Legal AI

A Stanford University study found that legal AI models hallucinated between **58-82%** of the time on legal queries. Even specialized tools (Lexis+ AI, Westlaw AI-Assisted Research) produced hallucinations in **17-34%** of cases. By mid-2025, public reporting had documented a growing number of court filings and legal decisions involving AI-generated hallucinated citations, including the Mata v. Avianca case (fabricated court decisions) and a Georgia Court of Appeals case where 11 of 15 cited cases were hallucinated.

### 4.3 Code Generation

A 2024 study across seven LLMs (GPT-4, Claude-3, Llama-3, etc.) on 1,164 programming problems identified seven categories of non-syntactic errors — code that compiles but is semantically wrong. **84.21% of incorrectly generated code** required more than 50 edits (Levenshtein distance) to fix. LLMs consistently prioritize "syntactic plausibility over comprehensive functional integrity," producing code that passes casual review but fails on edge cases, boundary conditions, or semantic requirements.

Representative semantic error categories: missing conditions, wrong logical direction, incorrect boundary handling, misunderstood API contracts, off-by-one errors that propagate, incorrect state mutation ordering.

### 4.4 Trust Calibration Crisis

The asymmetry between model confidence and actual reliability creates a user trust calibration problem. Over-reliance is the dominant risk (users treat AI outputs as more reliable than they are), but under-trust is equally costly — users who learn they cannot trust AI confidence signals discard even correct high-confidence outputs.

---

## 5. State-of-the-Art Solutions

### 5.1 Conformal Prediction

Conformal prediction provides distribution-free uncertainty quantification with finite-sample coverage guarantees. Rather than a single answer, the system outputs a *prediction set* guaranteed to contain the true answer with probability >= 1-alpha.

Key developments:

- **ConU** (EMNLP Findings 2024): Applied conformal prediction to black-box LLMs in open-ended generation using self-consistency as a nonconformity score.
- **Token-Entropy Conformal Prediction (TECP, 2025)**: Uses log-probability-based token entropy as the nonconformity score, constructing prediction sets with finite-sample coverage guarantees.
- **Paraphrase-Robust Conformal Prediction (2025)**: Addresses fragility of conformal guarantees under input paraphrasing — a critical practical concern since LLM outputs are sensitive to surface-level input changes.
- **Selective Conformal Uncertainty (ACL 2025)**: Combines conformal prediction with selective prediction, allowing the system to abstain when uncertainty is too high.
- **LLM-as-Judge Conformal (2025)**: Applies conformal prediction to quantify uncertainty in LLM evaluation outputs, producing prediction intervals rather than point scores.

Key advantage: statistical guarantees without model internals access (critical for black-box APIs). Key limitation: guarantees are marginal (averaged over the test distribution), not conditional on specific inputs — you know the system is calibrated *on average*, not for *this specific query*.

### 5.2 Calibration Techniques

**Temperature scaling** remains the simplest post-hoc method: a single scalar parameter learned on a validation set rescales logits. **Platt scaling** fits logistic regression on model confidence scores. Both reduce ECE but cannot fix fundamental calibration issues in the model itself.

**Ensemble methods** — multiple models or configurations, aggregated — provide better-calibrated uncertainty. Disagreement across ensemble members is a genuine uncertainty signal. However, ensembles are expensive and suffer from correlated failures when models share training data.

**SteerConf (2025)** introduced steering prompt strategies that guide LLMs to produce confidence scores in specified directions, operating without additional training. This is essentially prompt engineering for calibration — lightweight but fragile.

**Fact-Level Confidence Calibration (2025)** addresses a key limitation: most methods produce a single confidence score per response, but long-form generation contains multiple atomic facts with different confidence levels. This work decomposes response-level confidence into fact-level confidence, enabling targeted self-correction.

### 5.3 Abstention Mechanisms

The Art of Refusal survey (2024-2025) formalized LLM abstention — the ability to say "I don't know" instead of guessing. Empirical results show abstention based on appropriate uncertainty measures can:

- Improve correctness by **up to 8%**
- Avoid **50% of hallucinations** by correctly identifying unanswerable questions
- Increase safety by **70-99%**

Two uncertainty measure categories: *statistical* (token entropy, sequence probability) and *verbalized* (In Dialogue Uncertainty / InDU, tracking hedge words). A key finding: statistical and verbalized uncertainty are **poorly correlated** — a model may express high verbalized confidence ("I am certain that...") while its token-level entropy is high, or vice versa.

### 5.4 RAG as Partial Epistemic Humility

Retrieval-Augmented Generation grounds outputs in retrievable sources, making claims falsifiable. However, RAG introduces its own epistemic risks: the model may hallucinate that a retrieved passage supports a claim when it does not (faithfulness hallucination), or fail to retrieve relevant contradicting evidence (retrieval failure). RAG reduces but does not eliminate the epistemic humility deficit.

### 5.5 LLM-as-Judge Calibration

Using LLMs to evaluate other LLMs is increasingly common but introduces second-order calibration concerns. A 2025 study applied conformal prediction to quantify LLM judge uncertainty. Fundamental limitation: an LLM judge shares many epistemic blind spots with the LLM being judged. This is precisely the problem Vinyan's Axiom A1 (Epistemic Separation) addresses — verification must use systems with *different failure modes* than the generator.

---

## 6. Multi-Agent Systems and Epistemic Amplification

### 6.1 Error Propagation and the Orchestration Penalty

Cemri, Pan, and Yang (2025) identified systematic failure modes in multi-agent architectures: "no or incomplete verification that allows errors to propagate undetected" and "failure in propagating correct context to dependent agents/tools." Despite increasing adoption, multi-agent systems show **minimal accuracy gains** compared to single-agent frameworks or simple baselines like best-of-N sampling.

The "Orchestration Penalty" concept (2025-2026) formalizes the factorial increase in verification complexity in multi-step reasoning loops. Simulation results reveal **Agentic Collapse** — a catastrophic phase transition where stochastic complexity spikes drive the system into an irretrievable high-entropy state before lagged verification compensates. This is the computational analog of compositional overconfidence: each step adds uncertainty that the system cannot absorb.

### 6.2 Echo Chambers and Groupthink

Multi-agent LLM systems risk epistemic echo chambers. Research documents that triads "collapse into rubber-stamping if critics are weak or correlated" and committees "suffer from groupthink or capture by dominant agents." When multiple LLM instances share similar training distributions, their "agreement" provides no additional epistemic evidence — it is confidence laundering at the system level.

Risk factors identified in multi-agent research (2025): information asymmetries, network effects, selection pressures, destabilizing dynamics, commitment problems, emergent agency, and multi-agent security vulnerabilities.

### 6.3 AI Debate as Epistemic Mechanism

Irving et al. (2018) proposed adversarial debate between AI agents as an alignment mechanism. Du et al. (2023, ICML 2024) demonstrated that multi-agent debate improves factuality and reasoning. Theoretical foundation: debate between provers captures complexity class PSPACE (extended to NEXP with cross-examination by Barnes & Christiano, 2020).

However, a 2025 controlled study ("Can LLM Agents Really Debate?") questioned whether LLM debates exhibit genuine adversarial dynamics or merely converge to shared biases. If debating agents share training data and thus similar blind spots, the debate mechanism provides less epistemic value than its theoretical framework suggests.

### 6.4 The Verifier's Dilemma

Who verifies the verifier? In systems where LLMs check other LLMs, the verification chain has no epistemic anchor. Two LLMs trained on similar data share similar blind spots, making cross-verification less valuable than it appears. This is distinct from the halting problem — it is a practical issue of correlated failure modes.

**Vinyan's architectural response:** Axiom A1 (Epistemic Separation) mandates that generation and verification are performed by different components with *structurally different failure modes*. Axiom A5 (Tiered Trust) establishes that deterministic evidence outranks probabilistic evidence. An AST parser cannot hallucinate about symbol existence; a type checker cannot be sycophantic about type compatibility. The tier-clamp system (`src/oracle/tier-clamp.ts`) enforces this: deterministic engines cap at confidence 1.0, heuristic at 0.9, probabilistic at 0.7, speculative at 0.4. No amount of LLM confidence can exceed the ceiling imposed by its trust tier.

---

## 7. Measurement and Benchmarks

| Benchmark/Metric | What It Measures | Status (2025) | Key Limitation |
|---|---|---|---|
| **TruthfulQA** | Truthfulness vs. helpfulness (817 Q, 38 domains) | Widely used | Static; known misconceptions only |
| **HaluEval** | Hallucination detection (QA, dialogue, summarization) | Active | Tests detection, not prevention |
| **FActScore** | Factual precision of long-form generation | Active | Requires reference KB; expensive |
| **ECE / MCE** | Calibration gap across binned predictions | Standard | Sensitive to bin choice |
| **AUROC** | Discriminating own correct vs. incorrect outputs | Standard | Ranking metric, not absolute |
| **Brier Score** | Combined calibration and discrimination | Standard | Single scalar; loses diagnostic detail |
| **Selective Acc-Coverage** | Accuracy at various abstention thresholds | Emerging | Tradeoff curve, not single metric |
| **Conformal coverage** | Finite-sample coverage guarantee of prediction sets | Emerging | Marginal, not conditional |

A 2025 study questioned whether calibrated probabilities are even the correct metric for human-AI collaboration, arguing that decision-relevant uncertainty communication may require different representations than well-calibrated scalar confidence. This echoes the distinction in the philosophical companion document between calibration (a statistical property) and epistemic humility (a structural property of knowledge systems).

---

## 8. Critical Gaps: What Current Research Has Not Solved

### Gap 1: No Ground Truth for Epistemic States
There is no accepted method for determining what an LLM "actually knows" versus what it can generate text about. Internal representation probing shows promise but remains unreliable for high-stakes decisions. Without ground truth for epistemic state, all calibration is approximate.

### Gap 2: Compositional Uncertainty Propagation
No production system correctly propagates uncertainty through multi-step agentic reasoning chains. Each step's uncertainty should constrain the next step's confidence ceiling. Conformal prediction offers theoretical tools, but practical application to sequential agent decision-making remains open.

### Gap 3: Adversarial Robustness of Uncertainty Estimates
Calibration techniques are calibrated on benign distributions. Under adversarial inputs, prompt injection, or distribution shift, uncertainty estimates degrade unpredictably. A model may report low uncertainty precisely when it is being manipulated.

### Gap 4: Cross-Domain Calibration Transfer
A model well-calibrated on medical QA may be poorly calibrated on legal reasoning. Per-domain calibration requires labeled data that may not exist for novel applications.

### Gap 5: The Sycophancy-Honesty Tradeoff
RLHF cannot simultaneously optimize for helpfulness (which users reward) and epistemic honesty (which users often penalize). The fundamental tension between "tell me what I want to hear" and "tell me what is true" remains unresolved at the training objective level.

### Gap 6: Verification Beyond Formal Domains
Deterministic verification (type checkers, AST, test suites) provides the strongest epistemic guarantees but is limited to domains with formal verification tools. Extending verification to natural language claims, business logic correctness, or creative quality remains open. This is the boundary where Vinyan's oracle framework reaches its current limit — the framework is domain-agnostic, but current implementations are code-specific.

### Gap 7: Real-Time Calibration Drift
Current calibration methods are static — trained on a validation set, applied at inference. Models in production encounter distributional drift, but calibration is not updated. Online calibration methods exist in theory but are not deployed at scale.

### Gap 8: Multi-Agent Epistemic Protocol
When multiple agents collaborate, there is no standard protocol for communicating epistemic state between them. Confidence scores from different models are not comparable. Evidence provenance is lost at agent boundaries. This is the gap that Vinyan's ECP (Epistemic Communication Protocol) and A2A confidence injection (`src/a2a/confidence-injector.ts`) are designed to fill — a protocol where confidence, evidence chains, falsifiability, and temporal context are first-class citizens, not metadata.

---

## 9. Implications for Vinyan

The research landscape validates Vinyan's core architectural decisions:

| Vinyan Mechanism | Research Problem Addressed | Gap Remaining |
|---|---|---|
| A1: Epistemic Separation (gen != verify) | Verifier's dilemma, LLM-as-judge blind spots | Extending to non-formal domains |
| A2: First-Class Unknown (`type: 'unknown'`) | Abstention mechanisms, metacognitive blindness | Unknown unknowns detection |
| A4: Content-Addressed Truth (SHA-256 hashes) | Temporal calibration drift, stale knowledge | Real-time invalidation at scale |
| A5: Tiered Trust (det > heur > prob) | Echo chambers, confidence laundering | Cross-agent tier negotiation |
| A7: Prediction Error as Learning | Calibration techniques, self-model | Cold-start problem for new domains |
| Tier-clamp system | Calibration failure, overconfidence | Domain-adaptive caps |
| GAP-H detectors (FC4/FC9/FC11) | Multi-agent failure modes, error propagation | Additional failure mode coverage |
| Temporal decay | Calibration drift, stale facts | Optimal decay model selection |
| ECP confidence injection (A2A) | Multi-agent epistemic protocol gap | Cross-instance trust bootstrapping |

The most critical gap for Vinyan's roadmap is **Gap 6** (verification beyond formal domains). Vinyan's epistemic guarantees are strongest where deterministic oracles exist (code, types, dependencies). Extending these guarantees to natural language correctness, business logic, or creative quality requires new oracle types that likely involve probabilistic verification — which, by A5, must be treated as lower-tier evidence with clamped confidence.

---

## References

- Xu, Z., Jain, S. & Kankanhalli, M. (2024). "Hallucination is Inevitable: An Innate Limitation of Large Language Models." *arXiv:2401.11817*.
- Xu, B. (2025). "Hallucination is Inevitable for LLMs with the Open World Assumption." *arXiv:2510.05116*.
- Huang, S. et al. (2025). "Hallucinations are Inevitable but Can Be Made Statistically Negligible." *arXiv:2502.12187*.
- Cheng, L. et al. (2024). "Sycophancy in Large Language Models: Causes and Mitigations." *arXiv:2411.15287*.
- Nature Digital Medicine (2025). "When Helpfulness Backfires: LLMs and the Risk of False Medical Information Due to Sycophantic Behavior."
- ELEPHANT (ICLR 2026). "Measuring and Understanding Social Sycophancy in LLMs."
- QA-Calibration (ICLR 2025). "Calibration of Language Model Confidence Scores."
- JMIR Medical Informatics (2025). "Benchmarking the Confidence of Large Language Models in Answering Clinical Questions."
- ConU (EMNLP Findings 2024). "Conformal Uncertainty in Large Language Models with Correctness Coverage Guarantees."
- NAACL 2024. "A Survey of Confidence Estimation and Calibration in Large Language Models."
- MICCAI 2025. "Confidence Calibration for Multimodal LLMs."
- SteerConf (2025). "Steering LLMs for Confidence Elicitation." *arXiv:2503.02863*.
- Fact-Level Confidence Calibration (2025). "Empowering Confidence-Guided LLM Self-Correction."
- Cemri, M., Pan, M.Z. & Yang, S. (2025). "Why Do Multi-Agent LLM Systems Fail?" *arXiv:2503.13657*.
- "Agentic Collapse" (2025). "A Time-Delayed Cybernetic Framework for Epistemic Stability in Autonomous AI Systems."
- Multi-Agent Risks (2025). *arXiv:2502.14143*.
- Du, Y. et al. (2023/ICML 2024). "Improving Factuality and Reasoning through Multiagent Debate."
- Irving, G. et al. (2018). "AI Safety via Debate." *arXiv:1805.00899*.
- "Can LLM Agents Really Debate?" (2025). *arXiv:2511.07784*.
- The Art of Refusal (2024). "A Survey of Abstention in Large Language Models."
- Uncertainty-Based Abstention (2025). *OpenReview*.
- Liu, J. et al. (2024). "What's Wrong with Your Code Generated by LLMs?" *arXiv:2407.06153*.
- "A Deep Dive Into LLM Code Generation Mistakes" (2024). *arXiv:2411.01414*.
- Dahl, M. et al. (2024). "Hallucinating Law: Legal Mistakes with LLMs are Pervasive." *Stanford Law School*.
- MIT Media Lab (2025). "Medical Hallucination in Foundation Models."
- Kalai, A.T. et al. (2025). "Why Language Models Hallucinate." *OpenAI Research*.
- Conformal Prediction for NLP: A Survey. *TACL 2025*.

---

Sources:
- [Hallucination is Inevitable (Xu et al., 2024)](https://arxiv.org/abs/2401.11817)
- [Hallucinations Can Be Made Statistically Negligible (Huang et al., 2025)](https://arxiv.org/abs/2502.12187)
- [Sycophancy in LLMs: Causes and Mitigations](https://arxiv.org/abs/2411.15287)
- [When Helpfulness Backfires (Nature Digital Medicine, 2025)](https://www.nature.com/articles/s41746-025-02008-z)
- [ELEPHANT: Social Sycophancy in LLMs (ICLR 2026)](https://openreview.net/forum?id=igbRHKEiAs)
- [QA-Calibration (ICLR 2025)](https://assets.amazon.science/6d/70/c50b2eb141d3bcf1565e62b60211/qa-calibration-of-language-model-confidence-scores.pdf)
- [Benchmarking LLM Confidence in Clinical QA (JMIR, 2025)](https://medinform.jmir.org/2025/1/e66917)
- [Confidence Estimation and Calibration Survey (NAACL 2024)](https://aclanthology.org/2024.naacl-long.366/)
- [ConU: Conformal Uncertainty in LLMs (EMNLP 2024)](https://arxiv.org/abs/2407.00499)
- [Confidence Calibration for Multimodal LLMs (MICCAI 2025)](https://papers.miccai.org/miccai-2025/paper/1840_paper.pdf)
- [Conformal Prediction for NLP: A Survey (TACL)](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00715/125278/Conformal-Prediction-for-Natural-Language)
- [Selective Conformal Uncertainty (ACL 2025)](https://aclanthology.org/2025.acl-long.934.pdf)
- [Why Do Multi-Agent LLM Systems Fail? (2025)](https://arxiv.org/html/2503.13657v1)
- [Agentic Collapse Framework (2025)](https://www.researchgate.net/publication/399368003_AGENTIC_COLLAPSE_A_TIME-DELAYED_CYBERNETIC_FRAMEWORK_FOR_EPISTEMIC_STABILITY_IN_AUTONOMOUS_AI_SYSTEMS)
- [Multi-Agent Risks from Advanced AI (2025)](https://arxiv.org/abs/2502.14143)
- [Improving Factuality through Multiagent Debate (Du et al.)](https://arxiv.org/abs/2305.14325)
- [Can LLM Agents Really Debate? (2025)](https://arxiv.org/pdf/2511.07784)
- [The Art of Refusal: Abstention in LLMs](https://www.aimodels.fyi/papers/arxiv/art-refusal-survey-abstention-large-language-models)
- [Uncertainty-Based Abstention in LLMs](https://openreview.net/forum?id=1DIdt2YOPw)
- [Code Generation Errors in LLMs (Liu et al., 2024)](https://arxiv.org/abs/2407.06153)
- [Deep Dive Into LLM Code Generation Mistakes (2024)](https://arxiv.org/html/2411.01414v1)
- [Hallucinating Law (Stanford, 2024)](https://law.stanford.edu/2024/01/11/hallucinating-law-legal-mistakes-with-large-language-models-are-pervasive/)
- [AI Hallucination Cases Database](https://www.damiencharlotin.com/hallucinations/)
- [Medical Hallucination in Foundation Models (MIT, 2025)](https://arxiv.org/html/2503.05777v2)
- [Real Life Examples of AI Hallucination Risks](https://cottrillresearch.com/real-life-examples-of-risks-associated-with-ai-hallucinations/)
- [TruthfulQA Leaderboard](https://llm-stats.com/benchmarks/truthfulqa)
- [Fact-Level Confidence Calibration](https://openreview.net/forum?id=bCAxEwwmBr)
- [SteerConf: Steering LLMs for Confidence (2025)](https://arxiv.org/pdf/2503.02863)
- [LLM Overconfidence in Document-Based Queries (2025)](https://arxiv.org/html/2509.25498v1)
- [Hallucination Detection and Mitigation Survey (2026)](https://arxiv.org/pdf/2601.09929)
- [Why Your Multi-Agent System is Failing: The 17x Error Trap](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/)
- [Detecting Silent Failures in Multi-Agentic AI](https://arxiv.org/pdf/2511.04032)
