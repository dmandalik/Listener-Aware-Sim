; ─────────────────────────────────────────────────────────────────────────────
; TELEOP domain (drive a robot to a goal tile on a grid).
;
; Symbolic STRIPS abstraction of the teleop game, modelled after MARLHospital's
; hospital_robotouille.pddl: the domain holds only the "physics" (movement + goal),
; and a capability predicate gates what an agent can do. Skill level, effort, and
; the message received live OUTSIDE the PDDL, in the side profile (profile.json) —
; the same split MARLHospital uses (PDDL planner + a separate state/skill layer).
;
; The novice/expert manipulation is the (knows-controls) predicate: the expert holds
; the key->direction map and can `press-key` deterministically; the novice does not,
; so they only have the abstract `move` (which stands in for guessing a key). Both
; reach the goal — the DIFFERENCE in how hard that was is recorded in the profile,
; not here.
; ─────────────────────────────────────────────────────────────────────────────
(define (domain teleop)
  (:requirements :strips :typing :disjunctive-preconditions)
  (:types
    cell direction key player - object
  )
  (:predicates
    (at ?p - player ?c - cell)                       ; where the robot is
    (adjacent ?from - cell ?to - cell ?d - direction) ; grid step in a direction
    (goal-cell ?c - cell)                            ; the tile to reach
    (knows-controls ?p - player)                     ; expert holds the key map; novice does not
    (maps-to ?k - key ?d - direction)                ; the control map (which key moves which way)
  )

  ; Abstract one-step move in a direction. Available to everyone: it represents a
  ; correct step regardless of how the agent found the right key.
  (:action move
    :parameters (?p - player ?from - cell ?to - cell ?d - direction)
    :precondition (and (at ?p ?from) (adjacent ?from ?to ?d))
    :effect (and (not (at ?p ?from)) (at ?p ?to))
  )

  ; Deterministic keyed move: only an agent who KNOWS the control map can pick the
  ; key for a direction on purpose. This is the expert-only capability.
  (:action press-key
    :parameters (?p - player ?k - key ?d - direction ?from - cell ?to - cell)
    :precondition (and (knows-controls ?p) (maps-to ?k ?d)
                       (at ?p ?from) (adjacent ?from ?to ?d))
    :effect (and (not (at ?p ?from)) (at ?p ?to))
  )
)
