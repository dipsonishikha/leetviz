#lang racket/base
;; LeetViz driver for Racket solutions.
;;
;;   racket lv.rkt serve <solution.rkt> <function> <param types...> -> <void|value>
;;   racket lv.rkt trace <solution.rkt> <function> ...   (JSON request on stdin)
;;
;; Tracing is per function call: every function the solution defines (top-level, internal
;; defines and named-let loops) is wrapped so each call records its arguments and each return its
;; result. The solution is read with source locations, so the trace points at the user's lines.
(require racket/list racket/string racket/port racket/set racket/math racket/file json)

(define-values (mode file fname type-args)
  (let ([a (current-command-line-arguments)])
    (values (vector-ref a 0) (vector-ref a 1) (string->symbol (vector-ref a 2)) (drop (vector->list a) 3))))

(define-values (param-types void-return?)
  (let-values ([(ps rest) (splitf-at type-args (λ (s) (not (string=? s "->"))))])
    (values ps (equal? (cadr rest) "void"))))

;; ------------------------------------------------------------------ the solution's namespace

(define ns (make-base-namespace))
(define prelude
  '((require racket racket/contract racket/list racket/set racket/hash racket/string racket/math racket/vector)
    (struct list-node (val next) #:mutable #:transparent)
    (define (make-list-node [val 0]) (list-node val #f))
    (struct tree-node (val left right) #:mutable #:transparent)
    (define (make-tree-node [val 0]) (tree-node val #f #f))))
(parameterize ([current-namespace ns])
  (for ([f prelude]) (eval f)))
(define (ns-ref sym) (parameterize ([current-namespace ns]) (eval sym)))
(define list-node? (ns-ref 'list-node?))
(define list-node (ns-ref 'list-node))
(define list-node-val (ns-ref 'list-node-val))
(define list-node-next (ns-ref 'list-node-next))
(define tree-node? (ns-ref 'tree-node?))
(define tree-node (ns-ref 'tree-node))
(define tree-node-val (ns-ref 'tree-node-val))
(define tree-node-left (ns-ref 'tree-node-left))
(define tree-node-right (ns-ref 'tree-node-right))
(define set-tree-node-left! (ns-ref 'set-tree-node-left!))
(define set-tree-node-right! (ns-ref 'set-tree-node-right!))

;; ------------------------------------------------------------------ values in the trace format

(define MAX-ITEMS 120)
(define MAX-DEPTH 3)
(define ids (make-weak-hasheq))
(define next-id 1)
(define (id-of v) (hash-ref! ids v (λ () (begin0 next-id (set! next-id (add1 next-id))))))

(define (short v)
  (define s (cond [(string? v) (jsexpr->string v)] [(list-node? v) (short (list-node-val v))] [(tree-node? v) (short (tree-node-val v))]
                  [else (format "~v" v)]))
  (if (> (string-length s) 80) (string-append (substring s 0 77) "...") s))

(define (ser v [depth 0])
  (cond
    [(boolean? v) (hasheq 't "prim" 'v (if v "#t" "#f") 'k "bool")]
    [(void? v) (hasheq 't "prim" 'v "(void)" 'k "null")]
    [(exact-integer? v) (if (< (abs v) (expt 2 53)) (hasheq 't "prim" 'v (number->string v) 'k "num" 'num v) (hasheq 't "prim" 'v (number->string v) 'k "num"))]
    [(real? v) (hasheq 't "prim" 'v (number->string v) 'k "num")]
    [(string? v) (hasheq 't "str" 'v (if (> (string-length v) 300) (substring v 0 300) v) 'more (> (string-length v) 300))]
    [(char? v) (hasheq 't "str" 'v (string v) 'char #t)]
    [(symbol? v) (hasheq 't "prim" 'v (format "'~a" v))]
    [(list-node? v)
     (let loop ([cur v] [nodes '()] [seen (hasheq)])
       (cond
         [(or (not (list-node? cur)) (>= (length nodes) 60))
          (hasheq 't "llist" 'nodes (reverse nodes) 'cycle 'null 'more (and (list-node? cur) #t))]
         [(hash-ref seen cur #f) => (λ (i) (hasheq 't "llist" 'nodes (reverse nodes) 'cycle i 'more #f))]
         [else (loop (list-node-next cur) (cons (hasheq 'id (id-of cur) 'val (short (list-node-val cur))) nodes) (hash-set seen cur (length nodes)))]))]
    [(tree-node? v)
     (let loop ([queue (list v)] [nodes (hasheq)])
       (cond
         [(or (null? queue) (>= (hash-count nodes) 63)) (hasheq 't "tree" 'root (number->string (id-of v)) 'nodes nodes)]
         [else
          (define n (car queue))
          (define key (string->symbol (number->string (id-of n))))
          (define l (tree-node-left n))
          (define r (tree-node-right n))
          (if (hash-ref nodes key #f)
              (loop (cdr queue) nodes)
              (loop (append (cdr queue) (filter tree-node? (list l r)))
                    (hash-set nodes key (hasheq 'val (short (tree-node-val n))
                                                'l (if (tree-node? l) (number->string (id-of l)) 'null)
                                                'r (if (tree-node? r) (number->string (id-of r)) 'null)))))]))]
    [(>= depth MAX-DEPTH) (hasheq 't "prim" 'v (short v))]
    [(list? v) (hasheq 't "list" 'kind "list" 'id (id-of v) 'len (length v) 'items (for/list ([x v] [_ MAX-ITEMS]) (ser x (add1 depth))))]
    [(vector? v) (hasheq 't "list" 'kind "vector" 'id (id-of v) 'len (vector-length v) 'items (for/list ([x v] [_ MAX-ITEMS]) (ser x (add1 depth))))]
    [(hash? v) (hasheq 't "dict" 'kind "hash" 'len (hash-count v)
                       'entries (for/list ([(k x) v] [_ MAX-ITEMS]) (list (if (string? k) k (short k)) (ser x (add1 depth)))))]
    [(set? v) (hasheq 't "set" 'len (set-count v) 'items (for/list ([x v] [_ MAX-ITEMS]) (ser x (add1 depth))))]
    [(pair? v) (hasheq 't "list" 'kind "pair" 'id 0 'len 2 'items (list (ser (car v) (add1 depth)) (ser (cdr v) (add1 depth))))]
    [(procedure? v) (hasheq 't "prim" 'v "<procedure>")]
    [(struct? v) (let ([vec (struct->vector v)])
                   (hasheq 't "obj" 'cls (string-trim (symbol->string (vector-ref vec 0)) "struct:")
                           'fields (for/hasheq ([x (in-vector vec 1)] [i (in-naturals)]) (values (string->symbol (format "field~a" i)) (ser x (add1 depth))))))]
    [else (hasheq 't "prim" 'v (short v))]))

(define (plain v)
  (cond
    [(list-node? v) (let loop ([c v] [acc '()] [k 0]) (if (and (list-node? c) (< k 100000)) (loop (list-node-next c) (cons (plain (list-node-val c)) acc) (add1 k)) (reverse acc)))]
    [(tree-node? v)
     (let loop ([q (list v)] [out '()])
       (cond
         [(or (null? q) (> (length out) 400000)) (trim-nulls (reverse out))]
         [else (define n (car q))
               (if (tree-node? n)
                   (loop (append (cdr q) (list (tree-node-left n) (tree-node-right n))) (cons (plain (tree-node-val n)) out))
                   (loop (cdr q) (cons 'null out)))]))]
    [(list? v) (map plain v)]
    [(vector? v) (map plain (vector->list v))]
    [(set? v) (map plain (set->list v))]
    [(hash? v) (for/hasheq ([(k x) v]) (values (string->symbol (format "~a" k)) (plain x)))]
    [(char? v) (string v)]
    [(symbol? v) (symbol->string v)]
    [(void? v) 'null]
    [(and (real? v) (not (exact? v))) (if (or (nan? v) (infinite? v)) 'null v)]
    [else v]))

(define (trim-nulls lst)
  (reverse (dropf (reverse lst) (λ (x) (eq? x 'null)))))

;; ------------------------------------------------------------------ inputs

(define (unpct t)
  (bytes->string/utf-8 (list->bytes
    (let loop ([cs (string->list (substring t 1))])
      (cond [(null? cs) '()]
            [(and (char=? (car cs) #\%) (>= (length cs) 3))
             (cons (string->number (list->string (list (cadr cs) (caddr cs))) 16) (loop (cdddr cs)))]
            [else (append (bytes->list (string->bytes/utf-8 (string (car cs)))) (loop (cdr cs)))])))
   #\?))

(define (read-arg toks type)
  (define (next!) (let ([l (unbox toks)]) (set-box! toks (cdr l)) (car l)))
  (cond
    [(member type '("integer" "long")) (string->number (next!))]
    [(equal? type "double") (exact->inexact (string->number (next!)))]
    [(equal? type "boolean") (equal? (next!) "1")]
    [(equal? type "string") (unpct (next!))]
    [(equal? type "character") (string-ref (unpct (next!)) 0)]
    [(equal? type "ListNode")
     (define n (string->number (next!)))
     (define vals (for/list ([_ n]) (string->number (next!))))
     (for/fold ([head #f]) ([v (reverse vals)]) (list-node v head))]
    [(equal? type "TreeNode")
     (define n (string->number (next!)))
     (define t (for/vector ([_ n]) (next!)))
     (cond
       [(or (zero? n) (equal? (vector-ref t 0) "#")) #f]
       [else
        (define root (tree-node (string->number (vector-ref t 0)) #f #f))
        (let loop ([q (list root)] [i 1])
          (when (and (pair? q) (< i n))
            (define node (car q))
            (define l (and (< i n) (not (equal? (vector-ref t i) "#")) (tree-node (string->number (vector-ref t i)) #f #f)))
            (define r (and (< (add1 i) n) (not (equal? (vector-ref t (add1 i)) "#")) (tree-node (string->number (vector-ref t (add1 i))) #f #f)))
            (set-tree-node-left! node l)
            (set-tree-node-right! node r)
            (loop (append (cdr q) (filter values (list l r))) (+ i 2))))
        root])]
    [(regexp-match #rx"^(.*)\\[\\]$" type) => (λ (m) (let ([n (string->number (next!))]) (for/list ([_ n]) (read-arg toks (cadr m)))))]
    [(regexp-match #rx"^list<(.*)>$" type) => (λ (m) (let ([n (string->number (next!))]) (for/list ([_ n]) (read-arg toks (cadr m)))))]
    [else (error 'leetviz "unsupported type ~a" type)]))

(define (read-args line)
  (define toks (box (string-split line)))
  (for/list ([t param-types]) (read-arg toks t)))

;; ------------------------------------------------------------------ tracing

(define steps '())
(define step-count 0)
(define max-steps 5000)
(define frames '()) ; innermost first: (vector fn line locals)
(define out-port #f)
(struct lv-limit ())

(define (stack-json)
  (for/list ([f (reverse frames)] [i (in-naturals)])
    (define depth-from-top (- (length frames) i))
    (if (<= depth-from-top 6)
        (hasheq 'fn (vector-ref f 0) 'line (vector-ref f 1) 'locals (vector-ref f 2))
        (hasheq 'fn (vector-ref f 0) 'line (vector-ref f 1)))))

(define (record! event line [extra (hasheq)])
  (when (>= step-count max-steps) (raise (lv-limit)))
  (set! step-count (add1 step-count))
  (define out-len (if out-port (file-position out-port) 0))
  (set! steps (cons (for/fold ([h (hasheq 'line line 'event event 'stack (stack-json) 'out out-len)]) ([(k v) extra]) (hash-set h k v)) steps)))

(define (lv-call name line args thunk)
  (define locals (for/hasheq ([a args]) (values (car a) (ser (cdr a)))))
  (set! frames (cons (vector (symbol->string name) line locals) frames))
  (record! "call" line)
  (define result (thunk))
  (record! "return" line (hasheq 'ret (ser result)))
  (set! frames (cdr frames))
  result)

;; Rewrite (define (f args...) body...) forms so calls go through lv-call.
(define (param-names ps)
  (cond [(null? ps) '()]
        [(symbol? ps) (list ps)] ; rest argument
        [(pair? ps) (let ([p (car ps)])
                      (cond [(symbol? p) (cons p (param-names (cdr ps)))]
                            [(keyword? p) (param-names (cdr ps))]
                            [(and (pair? p) (symbol? (car p))) (cons (car p) (param-names (cdr ps)))]
                            [else (param-names (cdr ps))]))]
        [else '()]))

(define (instrument stx)
  (define (line-of s) (or (syntax-line s) 0))
  (define (walk s)
    (define e (syntax-e s))
    (cond
      [(not (pair? e)) (syntax->datum s)]
      [else
       (define items (let loop ([x e]) (cond [(pair? x) (cons (car x) (loop (cdr x)))] [(null? x) '()] [(syntax? x) (let ([y (syntax-e x)]) (if (or (pair? y) (null? y)) (loop y) (list x)))] [else (list x)])))
       (define head (and (pair? items) (syntax? (car items)) (syntax-e (car items))))
       (define improper? (let loop ([x e]) (cond [(pair? x) (loop (cdr x))] [(null? x) #f] [(syntax? x) (let ([y (syntax-e x)]) (cond [(pair? y) (loop y)] [(null? y) #f] [else #t]))] [else #t])))
       (cond
         [(memq head '(quote quasiquote syntax)) (syntax->datum s)]
         [(and (memq head '(define define/contract)) (>= (length items) 3) (pair? (syntax-e (cadr items))))
          ;; (define (f . params) [contract] body ...)
          (define sig (syntax->datum (cadr items)))
          (define name (car sig))
          (define names (param-names (cdr sig)))
          (define rest (cddr items))
          (define-values (contract body) (if (eq? head 'define/contract) (values (list (syntax->datum (car rest))) (cdr rest)) (values '() rest)))
          (if (symbol? name)
              `(,head ,sig ,@contract
                (lv-call ',name ,(line-of s) (list ,@(for/list ([n names]) `(cons ',n ,n))) (λ () ,@(map walk body))))
              `(,head ,sig ,@contract ,@(map walk body)))]
         [(and (eq? head 'let) (>= (length items) 4) (symbol? (syntax-e (cadr items))))
          ;; named let: (let loop ([v init] ...) body ...)
          (define name (syntax-e (cadr items)))
          (define binds (syntax->datum (caddr items)))
          (define names (for/list ([b binds]) (if (pair? b) (car b) b)))
          `(let ,name ,(for/list ([b (syntax-e (caddr items))]) (let ([bb (syntax-e b)]) (if (pair? bb) (list (syntax->datum (car bb)) (walk (cadr bb))) (syntax->datum b))))
             (lv-call ',name ,(line-of s) (list ,@(for/list ([n names]) `(cons ',n ,n))) (λ () ,@(map walk (cdddr items)))))]
         [improper? (syntax->datum s)]
         [else (map walk items)])]))
  (walk stx))

(define (load-solution path instrument?)
  (define text (file->string path))
  (define in (open-input-string text))
  (port-count-lines! in)
  (parameterize ([current-namespace ns] [read-accept-reader #t] [read-accept-lang #t])
    (namespace-set-variable-value! 'lv-call lv-call)
    (let loop ()
      (define stx (read-syntax path in))
      (unless (eof-object? stx)
        (eval (if instrument? (instrument stx) (syntax->datum stx)))
        (loop)))))

(define (err-text e)
  (cond [(exn? e) (let ([m (exn-message e)]) (car (string-split m "\n")))]
        [else (format "~a" e)]))

(define (proto s) (write-string (string-append "\u0001LV " s "\n") (current-output-port)) (flush-output))

(cond
  [(equal? mode "trace")
   (define req (string->jsexpr (port->string (current-input-port))))
   (set! max-steps (hash-ref req 'maxSteps))
   (define result (make-hasheq))
   (with-handlers ([exn:fail? (λ (e) (hash-set! result 'error (err-text e)))])
     (load-solution file #t))
   (unless (hash-ref result 'error #f)
     (define fn (with-handlers ([exn:fail? (λ (e) #f)]) (ns-ref fname)))
     (cond
       [(not fn) (hash-set! result 'error (format "Couldn't find the function ~a in your code." fname))]
       [else
        (define args (read-args (hash-ref req 'tokens)))
        (set! out-port (open-output-file (hash-ref req 'stdout) #:exists 'replace))
        (with-handlers ([lv-limit? (λ (_) (hash-set! result 'truncated #t))]
                        [(λ (e) #t) (λ (e)
                                       (define msg (err-text e))
                                       (hash-set! result 'error msg)
                                       (when (pair? frames)
                                         (hash-set! result 'errorLine (vector-ref (car frames) 1))
                                         (set! steps (cons (hasheq 'line (vector-ref (car frames) 1) 'event "exception" 'stack (stack-json) 'out (file-position out-port) 'exc msg) steps))))])
          (define v (parameterize ([current-output-port out-port]) (apply fn args)))
          (hash-set! result 'returnPlain (jsexpr->string (plain (if void-return? (car args) v)))))
        (close-output-port out-port)]))
   (hash-set! result 'steps (reverse steps))
   (with-output-to-file (hash-ref req 'out) #:exists 'replace (λ () (write-json result)))]
  [else
   (define real-out (current-output-port))
   (define fn
     (with-handlers ([exn:fail? (λ (e) (proto (jsexpr->string (hasheq 'err (err-text e)))) #f)])
       (parameterize ([current-output-port (open-output-nowhere)]) (load-solution file #f))
       (ns-ref fname)))
   (when fn
     (for ([line (in-lines (current-input-port))])
       (define parts (string-split line))
       (define min-time (string->number (first parts)))
       (define max-runs (string->number (second parts)))
       (define rest (string-join (drop parts 3) " "))
       (define reply
         (with-handlers ([(λ (e) #t) (λ (e) (jsexpr->string (hasheq 'err (err-text e))))])
           ;; Racket's collector can pause in the middle of a run: start each size from a clean heap
           ;; and report the median run, which ignores the odd pause.
           (collect-garbage 'major)
           (let loop ([total 0.0] [times '()] [res #f])
             (define runs (length times))
             (if (and (> runs 0) (or (>= runs max-runs) (>= total min-time)))
                 (let ([median (list-ref (sort times <) (quotient runs 2))])
                   (format "{\"t\":~a,\"runs\":~a,\"mem\":-1,\"depth\":-1,\"out\":~a}" median runs (jsexpr->string res)))
                 (let* ([args (read-args rest)]
                        [t0 (current-inexact-milliseconds)]
                        [v (parameterize ([current-output-port (open-output-nowhere)]) (apply fn args))]
                        [dt (/ (- (current-inexact-milliseconds) t0) 1000.0)])
                   (loop (+ total dt) (cons dt times) (plain (if void-return? (car args) v))))))))
       (write-string (string-append "\u0001LV " reply "\n") real-out)
       (flush-output real-out)))])
