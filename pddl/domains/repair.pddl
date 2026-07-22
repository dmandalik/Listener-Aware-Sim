; ─────────────────────────────────────────────────────────────────────────────
; REPAIR domain (join the two correct parts on a board).
;
; Symbolic STRIPS abstraction, same shape as MARLHospital: the physics (connect) in
; the domain, the novice/expert manipulation as a capability predicate, and skill /
; effort / the message received kept in the side profile (profile.json).
;
; Several parts deliberately share a shape (the visual trap), so a bare visual
; description is not unique. Expert capability: (knows-part-names) — they see every
; part's name and can pick the pair by name. The novice sees only shapes and
; positions and must lean on the message. `connect` is available to both; whether
; they connected the RIGHT pair, and how long it took, is recorded in the profile.
; ─────────────────────────────────────────────────────────────────────────────
(define (domain repair)
  (:requirements :strips :typing :disjunctive-preconditions)
  (:types
    component shape name player - object
  )
  (:predicates
    (has-shape ?c - component ?s - shape)   ; the visible shape (shared by look-alikes)
    (has-name ?c - component ?n - name)     ; the part NAME (expert-only knowledge)
    (should-connect ?a - component ?b - component) ; the correct pair (the goal)
    (connected ?a - component ?b - component)
    (knows-part-names ?p - player)          ; expert sees the labels; novice does not
  )

  ; Drag one part onto another to connect them. Modelled as succeeding on the correct
  ; pair; a wrong attempt in the game costs a try, which is tracked in the profile.
  (:action connect
    :parameters (?p - player ?a - component ?b - component)
    :precondition (should-connect ?a ?b)
    :effect (connected ?a ?b)
  )
)
