# LeetViz driver for Ruby solutions (see server/lib/runner.js for the protocol).
#
#   ruby driver.rb trace|serve <solution.rb> <method> <param types...> -> <void|value>
#
# Ruby can trace itself: in trace mode a TracePoint records every line / call / return in the
# solution file, with a shadow stack of the frames' bindings for their locals.
require 'json'
require 'set'

class ListNode
  attr_accessor :val, :next
  def initialize(val = 0, _next = nil)
    @val = val
    @next = _next
  end
end

class TreeNode
  attr_accessor :val, :left, :right
  def initialize(val = 0, left = nil, right = nil)
    @val = val
    @left = left
    @right = right
  end
end

module LV
  MAX_ITEMS = 120
  MAX_DEPTH = 3
  FULL_FRAMES = 6

  def self.parse_type(s)
    return [:seq, parse_type(s[0..-3])] if s.end_with?('[]')
    return [:seq, parse_type(s[5..-2])] if s.start_with?('list<') && s.end_with?('>')
    [s.to_sym, nil]
  end

  def self.unpct(t)
    t[1..].gsub(/%([0-9a-fA-F]{2})/) { $1.hex.chr }.force_encoding('UTF-8')
  end

  def self.read(toks, t)
    k, of = t
    case k
    when :integer, :long then Integer(toks.shift)
    when :double then Float(toks.shift)
    when :boolean then toks.shift == '1'
    when :string, :character then unpct(toks.shift)
    when :ListNode
      vals = Array.new(Integer(toks.shift)) { Integer(toks.shift) }
      head = nil
      vals.reverse_each { |v| head = ListNode.new(v, head) }
      head
    when :TreeNode
      t2 = Array.new(Integer(toks.shift)) { toks.shift }
      return nil if t2.empty? || t2[0] == '#'
      root = TreeNode.new(Integer(t2[0]))
      q = [root]
      i = 1
      until q.empty? || i >= t2.size
        node = q.shift
        if i < t2.size && t2[i] != '#' then node.left = TreeNode.new(Integer(t2[i])); q << node.left end
        i += 1
        if i < t2.size && t2[i] != '#' then node.right = TreeNode.new(Integer(t2[i])); q << node.right end
        i += 1
      end
      root
    when :seq then Array.new(Integer(toks.shift)) { read(toks, of) }
    else raise ArgumentError, "unsupported type #{k}"
    end
  end

  def self.plain(v)
    case v
    when ListNode
      out = []
      while v && out.size < 100_000
        out << plain(v.val)
        v = v.next
      end
      out
    when TreeNode
      out = []
      q = [v]
      i = 0
      while i < q.size && q.size < 400_000
        n = q[i]
        if n then out << plain(n.val); q << n.left << n.right else out << nil end
        i += 1
      end
      out.pop while !out.empty? && out.last.nil?
      out
    when Array, Set then v.map { |x| plain(x) }
    when Hash then v.to_h { |k, x| [k.to_s, plain(x)] }
    when Float then v.finite? ? v : nil
    when Symbol then v.to_s
    else v
    end
  end

  # ---------------------------------------------------------------- values for the trace

  def self.short(v)
    s = v.is_a?(String) ? v.inspect : (v.is_a?(ListNode) || v.is_a?(TreeNode) ? v.val.inspect : v.inspect)
    s.size <= 80 ? s : "#{s[0, 77]}..."
  rescue StandardError
    '?'
  end

  def self.ser(v, depth = 0)
    case v
    when nil then { t: 'prim', v: 'nil', k: 'null' }
    when true, false then { t: 'prim', v: v.to_s, k: 'bool' }
    when Integer then { t: 'prim', v: v.to_s, k: 'num', num: v.abs < 2**53 ? v : nil }
    when Float then { t: 'prim', v: v.to_s, k: 'num' }
    when String then { t: 'str', v: v[0, 300], more: v.size > 300 }
    when Symbol then { t: 'prim', v: v.inspect }
    when ListNode
      nodes = []
      seen = {}
      cycle = nil
      cur = v
      while cur && nodes.size < 60
        if seen.key?(cur.object_id) then cycle = seen[cur.object_id]; break end
        seen[cur.object_id] = nodes.size
        nodes << { id: cur.object_id, val: short(cur.val) }
        cur = cur.next
      end
      { t: 'llist', nodes: nodes, cycle: cycle, more: !cur.nil? && cycle.nil? }
    when TreeNode
      nodes = {}
      q = [v]
      q.each do |n|
        break if nodes.size >= 63
        next if nodes.key?(n.object_id.to_s)
        nodes[n.object_id.to_s] = { val: short(n.val), l: n.left&.object_id&.to_s, r: n.right&.object_id&.to_s }
        q << n.left if n.left
        q << n.right if n.right
      end
      { t: 'tree', root: v.object_id.to_s, nodes: nodes }
    else
      return { t: 'prim', v: short(v) } if depth >= MAX_DEPTH
      case v
      when Array then { t: 'list', kind: 'Array', id: v.object_id, len: v.size, items: v.first(MAX_ITEMS).map { |x| ser(x, depth + 1) } }
      when Hash then { t: 'dict', kind: 'Hash', len: v.size, entries: v.first(MAX_ITEMS).map { |k, x| [k.is_a?(String) ? k : short(k), ser(x, depth + 1)] } }
      when Set then { t: 'set', len: v.size, items: v.first(MAX_ITEMS).map { |x| ser(x, depth + 1) } }
      when Proc, Method then { t: 'prim', v: '<function>' }
      else
        fields = v.instance_variables.first(30).to_h { |iv| [iv.to_s.delete('@'), ser(v.instance_variable_get(iv), depth + 1)] }
        { t: 'obj', cls: v.class.name || 'Object', fields: fields }
      end
    end
  rescue StandardError
    { t: 'prim', v: '?' }
  end

  class StepLimit < Exception; end # not a StandardError, so `rescue => e` can't swallow it

  # Ruby creates every local of a method up front (as nil); hide one until the line that first
  # assigns it has run, like other languages' debuggers do.
  @first_assign = {}

  def self.index_assignments(path)
    require 'prism'
    walk = lambda do |node|
      return unless node
      if node.respond_to?(:name) && node.class.name =~ /LocalVariable(Write|Target|OperatorWrite|OrWrite|AndWrite)Node/
        line = node.location.start_line
        @first_assign[node.name] = line if !@first_assign.key?(node.name) || line < @first_assign[node.name]
      end
      node.compact_child_nodes.each { |c| walk.call(c) }
    end
    walk.call(Prism.parse_file(path).value)
  rescue LoadError, StandardError
    @first_assign = {}
  end

  def self.locals(b, line = nil)
    b.local_variables.reject { |n| n.to_s.start_with?('_lv') }.each_with_object({}) do |n, out|
      v = b.local_variable_get(n)
      next if v.nil? && line && @first_assign.key?(n) && @first_assign[n] >= line
      out[n.to_s] = ser(v)
    end
  end

  def self.trace(path, args, method, max_steps, out_counter)
    steps = []
    frames = [] # [fn, binding, current line]
    last_raise = nil
    snapshot = lambda do |tp, event, extra = {}|
      raise StepLimit if steps.size >= max_steps
      stack = frames.each_with_index.map do |(fn, b, line), i|
        e = { fn: fn, line: line }
        e[:locals] = locals(b, line) if frames.size - i <= FULL_FRAMES
        e
      end
      steps << { line: tp.lineno, event: event, stack: stack, out: out_counter.call }.merge(extra)
    end
    tp = TracePoint.new(:call, :return, :line, :raise, :b_call, :b_return) do |t|
      next unless t.path == path
      case t.event
      when :call, :b_call
        frames << [t.event == :b_call ? 'block' : t.method_id.to_s, t.binding, t.lineno]
        snapshot.call(t, 'call')
      when :line
        next if frames.empty?
        frames[-1][2] = t.lineno
        snapshot.call(t, 'line')
      when :return, :b_return
        snapshot.call(t, 'return', ret: ser(t.return_value)) unless frames.empty?
        frames.pop
      when :raise
        next if t.raised_exception.is_a?(StepLimit)
        last_raise = [t.lineno, frames.map(&:dup)]
      end
    end
    result = { steps: steps }
    value = nil
    begin
      tp.enable
      value = TOPLEVEL_BINDING.receiver.send(method, *args)
    rescue StepLimit
      result[:truncated] = true
    rescue SystemStackError
      result[:error] = 'SystemStackError: stack level too deep (missing base case?)'
    rescue Exception => e # rubocop:disable Lint/RescueException
      result[:error] = "#{e.class}: #{e.message}"
      if last_raise
        line, fs = last_raise
        stack = fs.map { |fn, b, l| { fn: fn, line: l, locals: locals(b, l) } }
        steps << { line: line, event: 'exception', stack: stack, out: out_counter.call, exc: result[:error] } unless stack.empty?
        result[:errorLine] = line
      end
    ensure
      tp.disable
    end
    [result, value]
  end
end

mode, path, method, *rest = ARGV
arrow = rest.index('->')
ptypes = rest[0...arrow].map { |s| LV.parse_type(s) }
is_void = rest[arrow + 1] == 'void'
proto = $stdout.dup
proto.sync = true
path = File.expand_path(path)

begin
  load path
rescue SyntaxError, StandardError => e
  proto.puts "\u0001LV #{JSON.generate({ err: "#{e.class}: #{e.message.lines.first.to_s.strip}" })}"
  exit 0
end

if mode == 'trace'
  req = JSON.parse($stdin.read)
  toks = req['tokens'].split
  args = ptypes.map { |t| LV.read(toks, t) }
  # The solution's output goes to a file; its size is how much had been printed at each step.
  $stdout = File.open(req['stdout'], 'w')
  $stdout.sync = true
  LV.index_assignments(path)
  result, value = LV.trace(path, args, method, req['maxSteps'], -> { $stdout.pos })
  $stdout.close
  unless result[:error] || result[:truncated]
    plain = LV.plain(is_void ? args[0] : value)
    result[:returnPlain] = JSON.generate(plain)
  end
  File.write(req['out'], JSON.generate(result))
  exit 0
end

$stdout = $stderr # the solution's puts must not corrupt the protocol
$stdin.each_line do |line|
  parts = line.split
  min_time = parts[0].to_f
  max_runs = parts[1].to_i
  toks = parts[3..]
  reply =
    begin
      total = 0.0
      runs = 0
      mem = -1
      res = nil
      while runs < max_runs && (runs.zero? || total < min_time)
        tk = toks.dup
        args = ptypes.map { |t| LV.read(tk, t) }
        a0 = GC.stat(:total_allocated_objects)
        t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        value = TOPLEVEL_BINDING.receiver.send(method, *args)
        total += Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0
        mem = (GC.stat(:total_allocated_objects) - a0) * 40 if runs.zero?
        runs += 1
        res = is_void ? args[0] : value
      end
      JSON.generate({ t: total / runs, runs: runs, mem: mem, depth: -1, out: LV.plain(res) })
    rescue SystemStackError
      JSON.generate({ err: 'SystemStackError: stack level too deep (missing base case?)' })
    rescue Exception => e # rubocop:disable Lint/RescueException
      JSON.generate({ err: "#{e.class}: #{e.message}" })
    end
  proto.puts "\u0001LV #{reply}"
end
