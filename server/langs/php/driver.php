<?php
// LeetViz driver for PHP solutions (see server/lib/runner.js for the protocol).
//
//   php driver.php serve <solution.php> <method> <param types...> -> <void|value>
//   phpdbg ... driver.php trace <solution.php> <method> ...   (input from $LV_INPUT; see php.js)

class ListNode {
    public $val = 0;
    public $next = null;
    function __construct($val = 0, $next = null) { $this->val = $val; $this->next = $next; }
}

class TreeNode {
    public $val = null;
    public $left = null;
    public $right = null;
    function __construct($val = 0, $left = null, $right = null) { $this->val = $val; $this->left = $left; $this->right = $right; }
}

final class LV {
    const MAX_ITEMS = 120;
    const MAX_DEPTH = 3;
    static $toks = [];
    static $pos = 0;

    static function parseType($s) {
        if (substr($s, -2) === '[]') return ['seq', self::parseType(substr($s, 0, -2))];
        if (strncmp($s, 'list<', 5) === 0 && substr($s, -1) === '>') return ['seq', self::parseType(substr($s, 5, -1))];
        return [$s, null];
    }

    static function tok() { return self::$toks[self::$pos++]; }

    static function unpct($t) { return rawurldecode(substr($t, 1)); }

    static function read($t) {
        [$k, $of] = $t;
        switch ($k) {
            case 'integer': case 'long': return intval(self::tok());
            case 'double': return floatval(self::tok());
            case 'boolean': return self::tok() === '1';
            case 'string': case 'character': return self::unpct(self::tok());
            case 'ListNode': {
                $n = intval(self::tok()); $vals = [];
                for ($i = 0; $i < $n; $i++) $vals[] = intval(self::tok());
                $head = null;
                for ($i = $n - 1; $i >= 0; $i--) $head = new ListNode($vals[$i], $head);
                return $head;
            }
            case 'TreeNode': {
                $n = intval(self::tok()); $t2 = [];
                for ($i = 0; $i < $n; $i++) $t2[] = self::tok();
                if ($n === 0 || $t2[0] === '#') return null;
                $root = new TreeNode(intval($t2[0])); $q = [$root]; $h = 0; $i = 1;
                while ($h < count($q) && $i < $n) {
                    $node = $q[$h++];
                    if ($i < $n && $t2[$i] !== '#') { $node->left = new TreeNode(intval($t2[$i])); $q[] = $node->left; } $i++;
                    if ($i < $n && $t2[$i] !== '#') { $node->right = new TreeNode(intval($t2[$i])); $q[] = $node->right; } $i++;
                }
                return $root;
            }
            case 'seq': {
                $n = intval(self::tok()); $a = [];
                for ($i = 0; $i < $n; $i++) $a[] = self::read($of);
                return $a;
            }
        }
        throw new Exception("unsupported type $k");
    }

    static function plain($v) {
        if ($v instanceof ListNode) { $o = []; for ($c = $v, $k = 0; $c !== null && $k < 100000; $c = $c->next, $k++) $o[] = self::plain($c->val); return $o; }
        if ($v instanceof TreeNode) {
            $o = []; $q = [$v];
            for ($i = 0; $i < count($q) && count($q) < 400000; $i++) {
                if ($q[$i] === null) $o[] = null; else { $o[] = self::plain($q[$i]->val); $q[] = $q[$i]->left; $q[] = $q[$i]->right; }
            }
            while ($o && end($o) === null) array_pop($o);
            return $o;
        }
        if ($v instanceof SplDoublyLinkedList || $v instanceof SplHeap || $v instanceof SplPriorityQueue) return array_map([self::class, 'plain'], iterator_to_array(clone $v, false));
        if (is_array($v)) return array_is_list($v) ? array_map([self::class, 'plain'], $v) : array_map([self::class, 'plain'], $v);
        if (is_float($v) && !is_finite($v)) return null;
        return $v;
    }

    // ---------------------------------------------------------------- values for the trace

    static function short($v) {
        if (is_string($v)) $s = json_encode($v);
        elseif ($v instanceof ListNode || $v instanceof TreeNode) $s = var_export($v->val, true);
        elseif (is_scalar($v) || $v === null) $s = var_export($v, true);
        elseif (is_array($v)) $s = 'array(' . count($v) . ')';
        else $s = get_class($v);
        return strlen($s) <= 80 ? $s : substr($s, 0, 77) . '...';
    }

    static function ser($v, $depth = 0) {
        if ($v === null) return ['t' => 'prim', 'v' => 'null', 'k' => 'null'];
        if (is_bool($v)) return ['t' => 'prim', 'v' => $v ? 'true' : 'false', 'k' => 'bool'];
        if (is_int($v)) return ['t' => 'prim', 'v' => (string)$v, 'k' => 'num', 'num' => abs($v) < 2 ** 53 ? $v : null];
        if (is_float($v)) return ['t' => 'prim', 'v' => var_export($v, true), 'k' => 'num'];
        if (is_string($v)) return ['t' => 'str', 'v' => substr($v, 0, 300), 'more' => strlen($v) > 300];
        if ($v instanceof ListNode) {
            $nodes = []; $seen = []; $cycle = null; $c = $v;
            while ($c !== null && count($nodes) < 60) {
                $id = spl_object_id($c);
                if (isset($seen[$id])) { $cycle = $seen[$id]; break; }
                $seen[$id] = count($nodes);
                $nodes[] = ['id' => $id, 'val' => self::short($c->val)];
                $c = $c->next;
            }
            return ['t' => 'llist', 'nodes' => $nodes, 'cycle' => $cycle, 'more' => $c !== null && $cycle === null];
        }
        if ($v instanceof TreeNode) {
            $nodes = []; $q = [$v];
            for ($i = 0; $i < count($q) && count($nodes) < 63; $i++) {
                $n = $q[$i]; $id = (string)spl_object_id($n);
                if (isset($nodes[$id])) continue;
                $nodes[$id] = ['val' => self::short($n->val), 'l' => $n->left ? (string)spl_object_id($n->left) : null, 'r' => $n->right ? (string)spl_object_id($n->right) : null];
                if ($n->left) $q[] = $n->left;
                if ($n->right) $q[] = $n->right;
            }
            return ['t' => 'tree', 'root' => (string)spl_object_id($v), 'nodes' => (object)$nodes];
        }
        if ($depth >= self::MAX_DEPTH) return ['t' => 'prim', 'v' => self::short($v)];
        if (is_array($v)) {
            if (array_is_list($v)) {
                return ['t' => 'list', 'kind' => 'array', 'id' => 0, 'len' => count($v), 'items' => array_map(fn($x) => self::ser($x, $depth + 1), array_slice($v, 0, self::MAX_ITEMS))];
            }
            $e = [];
            foreach (array_slice($v, 0, self::MAX_ITEMS, true) as $k => $x) $e[] = [(string)$k, self::ser($x, $depth + 1)];
            return ['t' => 'dict', 'kind' => 'array', 'len' => count($v), 'entries' => $e];
        }
        if ($v instanceof SplStack) { $items = array_reverse(iterator_to_array(clone $v, false)); return ['t' => 'list', 'kind' => 'stack', 'id' => spl_object_id($v), 'len' => count($items), 'items' => array_map(fn($x) => self::ser($x, $depth + 1), array_slice($items, 0, self::MAX_ITEMS))]; }
        if ($v instanceof SplDoublyLinkedList) { $items = iterator_to_array(clone $v, false); return ['t' => 'list', 'kind' => 'deque', 'id' => spl_object_id($v), 'len' => count($items), 'items' => array_map(fn($x) => self::ser($x, $depth + 1), array_slice($items, 0, self::MAX_ITEMS))]; }
        if ($v instanceof SplHeap || $v instanceof SplPriorityQueue) { $items = iterator_to_array(clone $v, false); return ['t' => 'list', 'kind' => 'heap', 'id' => spl_object_id($v), 'len' => count($items), 'items' => array_map(fn($x) => self::ser($x, $depth + 1), array_slice($items, 0, self::MAX_ITEMS))]; }
        if ($v instanceof Closure) return ['t' => 'prim', 'v' => '<function>'];
        $fields = [];
        foreach (array_slice(get_object_vars($v), 0, 30, true) as $k => $x) $fields[$k] = self::ser($x, $depth + 1);
        return ['t' => 'obj', 'cls' => get_class($v), 'fields' => (object)$fields];
    }

    /** Locals of the paused frame as JSON (the tracer evaluates this inside each frame). */
    static function snap($vars) {
        $o = [];
        foreach ($vars as $k => $v) {
            if ($k === 'this' || $k === 'GLOBALS') continue;
            $o[$k] = self::ser($v);
        }
        return json_encode((object)$o, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    }
}

[, $mode, $file, $method] = $argv;
$rest = array_slice($argv, 4);
$arrow = array_search('->', $rest);
$ptypes = array_map([LV::class, 'parseType'], array_slice($rest, 0, $arrow));
$isVoid = $rest[$arrow + 1] === 'void';

$proto = fopen('php://stdout', 'w');
try {
    require $file;
    $target = class_exists('Solution') && method_exists('Solution', $method) ? [new Solution(), $method] : $method;
    if (!is_callable($target)) throw new Error("Couldn't find the function $method in your code.");
} catch (Throwable $e) {
    $msg = json_encode(['err' => get_class($e) . ': ' . $e->getMessage()]);
    if ($mode === 'trace') file_put_contents(getenv('LV_RESULT'), $msg); else fwrite($proto, "\x01LV $msg\n");
    exit(0);
}

function lv_args($line, $ptypes) {
    LV::$toks = preg_split('/ +/', trim($line), -1, PREG_SPLIT_NO_EMPTY);
    LV::$pos = 0;
    return array_map([LV::class, 'read'], $ptypes);
}

function lv_call($target, &$args) {
    // Pass by reference so in-place solutions (function f(&$nums)) modify our copy.
    $refs = [];
    foreach ($args as $i => &$a) $refs[$i] = &$a;
    return call_user_func_array(is_array($target) ? [new Solution(), $target[1]] : $target, $refs);
}

if ($mode === 'trace') {
    $outFile = getenv('LV_STDOUT');
    ob_start(function ($buf) use ($outFile) { if ($buf !== '') file_put_contents($outFile, $buf, FILE_APPEND); return ''; }, 1);
    $args = lv_args(file_get_contents(getenv('LV_INPUT')), $ptypes);
    $r = lv_call($target, $args);
    ob_end_flush();
    file_put_contents(getenv('LV_RESULT'), json_encode(LV::plain($isVoid ? $args[0] : $r)));
    exit(0);
}

ob_start(function ($buf) { return ''; }); // the solution's echo must not corrupt the protocol
while (($line = fgets(STDIN)) !== false) {
    $parts = preg_split('/ +/', trim($line), 4);
    $minTime = floatval($parts[0]); $maxRuns = intval($parts[1]); $toks = $parts[3] ?? '';
    try {
        $total = 0.0; $runs = 0; $mem = -1; $res = null;
        while ($runs < $maxRuns && ($runs === 0 || $total < $minTime)) {
            $args = lv_args($toks, $ptypes);
            if ($runs === 0) { gc_collect_cycles(); memory_reset_peak_usage(); $m0 = memory_get_usage(); }
            $t0 = hrtime(true);
            $value = lv_call($target, $args);
            $total += (hrtime(true) - $t0) / 1e9;
            if ($runs === 0) $mem = max(0, memory_get_peak_usage() - $m0);
            $runs++;
            $res = $isVoid ? $args[0] : $value;
        }
        $reply = json_encode(['t' => $total / $runs, 'runs' => $runs, 'mem' => $mem, 'depth' => -1, 'out' => LV::plain($res)]);
    } catch (Throwable $e) {
        $reply = json_encode(['err' => get_class($e) . ': ' . $e->getMessage()]);
    }
    fwrite($proto, "\x01LV $reply\n");
    fflush($proto);
}
