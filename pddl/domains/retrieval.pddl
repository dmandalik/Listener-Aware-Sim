; ─────────────────────────────────────────────────────────────────────────────
; RETRIEVAL domain (walk a building, pick up the one part the robot needs).
;
; Symbolic STRIPS abstraction, same shape as MARLHospital: physics (move + pick) in
; the domain, capability predicates for the novice/expert manipulation, and skill /
; effort / the message received kept in the side profile (profile.json).
;
; Expert capability: (knows-part-names) — they hold the parts key, so they can name
; the target; (knows-room-labels) — they see every room's name. The novice holds
; neither and must rely on the message plus the shapes it can see. Both can `pick`;
; how efficiently they found the RIGHT part is recorded in the profile.
; ─────────────────────────────────────────────────────────────────────────────
(define (domain retrieval)
  (:requirements :strips :typing :disjunctive-preconditions)
  (:types
    cell room item symbol part player - object
  )
  (:predicates
    (at ?p - player ?c - cell)          ; where the helper is standing
    (adjacent ?a - cell ?b - cell)      ; one tile step (any direction)
    (in-room ?c - cell ?r - room)       ; which room a tile belongs to
    (obj-at ?o - item ?c - cell)        ; where a part sits
    (holding ?p - player ?o - item)     ; carried part
    (hand-empty ?p - player)
    (is-target ?o - item)               ; the part the robot needs (the goal object)
    (has-symbol ?o - item ?s - symbol)  ; the shape a novice can see
    (has-part ?o - item ?pt - part)     ; the part NAME (expert-only knowledge)
    (knows-part-names ?p - player)      ; expert holds the parts key
    (knows-room-labels ?p - player)     ; expert sees room names
  )

  ; Step to an adjacent tile.
  (:action move
    :parameters (?p - player ?from - cell ?to - cell)
    :precondition (and (at ?p ?from) (adjacent ?from ?to))
    :effect (and (not (at ?p ?from)) (at ?p ?to))
  )

  ; Pick up a part in the current tile (a wrong pick costs an attempt in the game;
  ; that budget/consequence lives in the profile, not here).
  (:action pick
    :parameters (?p - player ?o - item ?c - cell)
    :precondition (and (at ?p ?c) (obj-at ?o ?c) (hand-empty ?p))
    :effect (and (holding ?p ?o) (not (hand-empty ?p)))
  )
)
