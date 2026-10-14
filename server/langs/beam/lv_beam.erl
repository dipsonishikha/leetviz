%% LeetViz driver for Erlang and Elixir solutions (both run on the BEAM).
%%
%%   erl -noshell -pa ... -run lv_beam main serve|trace erlang|elixir <Module> <function> <types...> -> <void|value>
%%
%% Tracing is per function call: erlang:trace/3 with return_trace records every call into the
%% solution module with its arguments, and every return with its result.
-module(lv_beam).
-export([main/1]).

-define(MAX_ITEMS, 120).
-define(MAX_DEPTH, 3).

main([Mode, Lang, Module, Fun | Rest]) ->
    {Types, ["=>", Ret]} = lists:splitwith(fun(T) -> T =/= "=>" end, Rest),
    Ctx = #{lang => list_to_atom(Lang), module => list_to_atom(Module), function => list_to_atom(Fun),
            types => [parse_type(T) || T <- Types], void => Ret =:= "void"},
    case Mode of
        "serve" -> serve(Ctx);
        "trace" -> trace(Ctx)
    end,
    halt(0).

%% ------------------------------------------------------------------ types and inputs

parse_type(S) ->
    case lists:suffix("[]", S) of
        true -> {seq, parse_type(lists:sublist(S, length(S) - 2))};
        false ->
            case S of
                "list<" ++ Inner -> {seq, parse_type(lists:droplast(Inner))};
                _ -> list_to_atom(S)
            end
    end.

null(#{lang := elixir}) -> nil;
null(_) -> null.

unpct([$" | T]) -> unicode:characters_to_binary(unpct_bytes(T));
unpct(T) -> unicode:characters_to_binary(T).
unpct_bytes([$%, A, B | T]) -> [list_to_integer([A, B], 16) | unpct_bytes(T)];
unpct_bytes([C | T]) -> [C | unpct_bytes(T)];
unpct_bytes([]) -> [].

to_number(S) ->
    case string:to_float(S) of
        {F, []} -> F;
        _ -> float(list_to_integer(S))
    end.

read(integer, [T | R], _) -> {list_to_integer(T), R};
read(long, [T | R], _) -> {list_to_integer(T), R};
read(double, [T | R], _) -> {to_number(T), R};
read(boolean, [T | R], _) -> {T =:= "1", R};
read(string, [T | R], _) -> {unpct(T), R};
read(character, [T | R], _) -> [C | _] = unicode:characters_to_list(unpct(T)), {C, R};
read('ListNode', [N | R], Ctx) ->
    {Vals, R2} = lists:split(list_to_integer(N), R),
    Node = lists:foldr(fun(V, Next) -> list_node(Ctx, list_to_integer(V), Next) end, null(Ctx), Vals),
    {Node, R2};
read('TreeNode', [N | R], Ctx) ->
    {Toks, R2} = lists:split(list_to_integer(N), R),
    {build_tree(Toks, Ctx), R2};
read({seq, Of}, [N | R], Ctx) ->
    {Rev, R2} = lists:foldl(fun(_, {Acc, Rest}) -> {V, Rest2} = read(Of, Rest, Ctx), {[V | Acc], Rest2} end, {[], R}, lists:seq(1, list_to_integer(N))),
    {lists:reverse(Rev), R2};
read(T, _, _) -> erlang:error({unsupported_type, T}).

list_node(#{lang := elixir}, V, Next) -> #{'__struct__' => 'Elixir.ListNode', val => V, next => Next};
list_node(_, V, Next) -> {list_node, V, Next}.

tree_node(#{lang := elixir}, V, L, R) -> #{'__struct__' => 'Elixir.TreeNode', val => V, left => L, right => R};
tree_node(_, V, L, R) -> {tree_node, V, L, R}.

%% Level-order tokens -> nested immutable nodes: build children first by index.
build_tree([], Ctx) -> null(Ctx);
build_tree(["#" | _], Ctx) -> null(Ctx);
build_tree(Toks, Ctx) ->
    T = list_to_tuple(Toks),
    N = tuple_size(T),
    %% Assign each non-null token its children's token indexes, as in a level-order build.
    {Kids, _} = lists:foldl(
        fun(I, {Acc, Next}) ->
            case element(I, T) of
                "#" -> {Acc, Next};
                _ ->
                    L = if Next =< N -> Next; true -> 0 end,
                    Rg = if Next + 1 =< N -> Next + 1; true -> 0 end,
                    {Acc#{I => {L, Rg}}, Next + 2}
            end
        end, {#{}, 2}, lists:seq(1, N)),
    make_node(1, T, Kids, Ctx).

make_node(0, _, _, Ctx) -> null(Ctx);
make_node(I, T, Kids, Ctx) ->
    case element(I, T) of
        "#" -> null(Ctx);
        V ->
            {L, R} = maps:get(I, Kids, {0, 0}),
            tree_node(Ctx, list_to_integer(V), make_node(L, T, Kids, Ctx), make_node(R, T, Kids, Ctx))
    end.

read_args(Line, Ctx) ->
    Toks = string:lexemes(Line, " \n"),
    {Rev, _} = lists:foldl(fun(T, {Acc, Rest}) -> {V, Rest2} = read(T, Rest, Ctx), {[V | Acc], Rest2} end, {[], Toks}, maps:get(types, Ctx)),
    lists:reverse(Rev).

%% ------------------------------------------------------------------ JSON

is_null(V) -> V =:= null orelse V =:= nil orelse V =:= undefined.

plain({list_node, _, _} = N) -> list_vals(N, []);
plain(#{'__struct__' := 'Elixir.ListNode'} = N) -> list_vals(N, []);
plain({tree_node, _, _, _} = N) -> tree_vals([N], []);
plain(#{'__struct__' := 'Elixir.TreeNode'} = N) -> tree_vals([N], []);
plain(V) when is_list(V) -> [plain(X) || X <- V];
plain(V) when is_map(V) -> maps:from_list([{key_text(K), plain(X)} || {K, X} <- maps:to_list(V)]);
plain(V) when is_tuple(V) -> [plain(X) || X <- tuple_to_list(V)];
plain(V) -> V.

node_val({list_node, V, _}) -> V;
node_val({tree_node, V, _, _}) -> V;
node_val(#{val := V}) -> V.
node_next({list_node, _, N}) -> N;
node_next(#{next := N}) -> N.
node_left({tree_node, _, L, _}) -> L;
node_left(#{left := L}) -> L.
node_right({tree_node, _, _, R}) -> R;
node_right(#{right := R}) -> R.

list_vals(N, Acc) ->
    case is_null(N) orelse length(Acc) > 100000 of
        true -> lists:reverse(Acc);
        false -> list_vals(node_next(N), [plain(node_val(N)) | Acc])
    end.

tree_vals(Queue, Acc) -> tree_vals(Queue, Acc, 0).
tree_vals([], Acc, _) -> trim_nulls(lists:reverse(Acc));
tree_vals(_, Acc, K) when K > 400000 -> trim_nulls(lists:reverse(Acc));
tree_vals([N | Q], Acc, K) ->
    case is_null(N) of
        true -> tree_vals(Q, [null | Acc], K + 1);
        false -> tree_vals(Q ++ [node_left(N), node_right(N)], [plain(node_val(N)) | Acc], K + 1)
    end.

trim_nulls(L) -> lists:reverse(lists:dropwhile(fun(X) -> X =:= null end, lists:reverse(L))).

key_text(K) when is_binary(K) -> K;
key_text(K) when is_atom(K) -> atom_to_binary(K, utf8);
key_text(K) -> iolist_to_binary(io_lib:format("~p", [K])).

json(V) when V =:= null; V =:= nil; V =:= undefined -> <<"null">>;
json(true) -> <<"true">>;
json(false) -> <<"false">>;
json(V) when is_integer(V) -> integer_to_binary(V);
json(V) when is_float(V) -> float_to_binary(V, [short]);
json(V) when is_binary(V) -> json_str(V);
json(V) when is_atom(V) -> json_str(atom_to_binary(V, utf8));
json(V) when is_list(V) -> iolist_to_binary([$[, lists:join($,, [json(X) || X <- V]), $]]);
json({ordered, Pairs}) -> % a JSON object that keeps its key order (Erlang maps sort keys)
    iolist_to_binary([${, lists:join($,, [[json_str(key_text(K)), $:, json(X)] || {K, X} <- Pairs]), $}]);
json(V) when is_map(V) ->
    iolist_to_binary([${, lists:join($,, [[json_str(key_text(K)), $:, json(X)] || {K, X} <- maps:to_list(V)]), $}]);
json(V) -> json_str(iolist_to_binary(io_lib:format("~p", [V]))).

json_str(B) ->
    Esc = [case C of
               $" -> "\\\"";
               $\\ -> "\\\\";
               C when C < 32 -> io_lib:format("\\u~4.16.0b", [C]);
               C -> <<C/utf8>>
           end || C <- unicode:characters_to_list(B)],
    iolist_to_binary([$", Esc, $"]).

%% ------------------------------------------------------------------ trace-format values

short(V) ->
    S = case V of
            B when is_binary(B) -> json_str(B);
            _ -> iolist_to_binary(io_lib:format("~0p", [V]))
        end,
    case byte_size(S) > 80 of true -> <<(binary:part(S, 0, 77))/binary, "...">>; false -> S end.

prim(V, K) -> #{t => <<"prim">>, v => V, k => K}.

ser(V) -> ser(V, 0).
ser(V, _) when V =:= null; V =:= nil; V =:= undefined -> prim(atom_to_binary(V, utf8), <<"null">>);
ser(V, _) when is_boolean(V) -> prim(atom_to_binary(V, utf8), <<"bool">>);
ser(V, _) when is_integer(V) -> (prim(integer_to_binary(V), <<"num">>))#{num => V};
ser(V, _) when is_float(V) -> prim(float_to_binary(V, [short]), <<"num">>);
ser(V, _) when is_binary(V) -> #{t => <<"str">>, v => V};
ser(V, _) when is_atom(V) -> #{t => <<"prim">>, v => atom_to_binary(V, utf8)};
ser({list_node, _, _} = N, _) -> ser_list(N);
ser(#{'__struct__' := 'Elixir.ListNode'} = N, _) -> ser_list(N);
ser({tree_node, _, _, _} = N, _) -> ser_tree(N);
ser(#{'__struct__' := 'Elixir.TreeNode'} = N, _) -> ser_tree(N);
ser(V, D) when D >= ?MAX_DEPTH -> #{t => <<"prim">>, v => short(V)};
ser(V, D) when is_list(V) ->
    #{t => <<"list">>, kind => <<"list">>, id => 0, len => length(V), items => [ser(X, D + 1) || X <- lists:sublist(V, ?MAX_ITEMS)]};
ser(V, D) when is_tuple(V) ->
    L = tuple_to_list(V),
    #{t => <<"list">>, kind => <<"tuple">>, id => 0, len => length(L), items => [ser(X, D + 1) || X <- L]};
ser(#{'__struct__' := S} = V, D) when is_atom(S) ->
    Name = iolist_to_binary(string:replace(atom_to_binary(S, utf8), "Elixir.", "")),
    case Name of
        <<"MapSet">> -> Items = maps:keys(maps:get(map, V)), #{t => <<"set">>, len => length(Items), items => [ser(X, D + 1) || X <- lists:sublist(Items, ?MAX_ITEMS)]};
        _ -> #{t => <<"obj">>, cls => Name, fields => maps:from_list([{key_text(K), ser(X, D + 1)} || {K, X} <- maps:to_list(V), K =/= '__struct__'])}
    end;
ser(V, D) when is_map(V) ->
    Entries = [[short_key(K), ser(X, D + 1)] || {K, X} <- lists:sublist(maps:to_list(V), ?MAX_ITEMS)],
    #{t => <<"dict">>, kind => <<"map">>, len => map_size(V), entries => Entries};
ser(V, _) when is_function(V) -> #{t => <<"prim">>, v => <<"<fun>">>};
ser(V, _) -> #{t => <<"prim">>, v => short(V)}.

short_key(K) when is_binary(K) -> K;
short_key(K) -> short(K).

ser_list(N) -> ser_list(N, [], 0).
ser_list(N, Acc, K) ->
    case is_null(N) orelse K >= 60 of
        true -> #{t => <<"llist">>, nodes => lists:reverse(Acc), cycle => null, more => not is_null(N)};
        false -> ser_list(node_next(N), [#{id => erlang:phash2({N, K}), val => short(node_val(N))} | Acc], K + 1)
    end.

ser_tree(Root) ->
    {Nodes, _} = tree_nodes([{Root, <<"1">>}], #{}, 0),
    #{t => <<"tree">>, root => <<"1">>, nodes => Nodes}.
tree_nodes([], Acc, K) -> {Acc, K};
tree_nodes(_, Acc, K) when K >= 63 -> {Acc, K};
tree_nodes([{N, Id} | Q], Acc, K) ->
    L = node_left(N), R = node_right(N),
    LId = <<Id/binary, "l">>, RId = <<Id/binary, "r">>,
    Kids = [{C, CId} || {C, CId} <- [{L, LId}, {R, RId}], not is_null(C)],
    Node = #{val => short(node_val(N)), l => case is_null(L) of true -> null; false -> LId end, r => case is_null(R) of true -> null; false -> RId end},
    tree_nodes(Q ++ Kids, Acc#{Id => Node}, K + 1).

%% ------------------------------------------------------------------ serve

err_text(Class, Reason) ->
    iolist_to_binary(io_lib:format("~s: ~0p", [Class, Reason])).

serve(Ctx) ->
    #{module := M, function := F, void := Void} = Ctx,
    {ok, Null} = file:open("/dev/null", [write]),
    group_leader(Null, self()),
    loop_serve(M, F, Void, Ctx).

loop_serve(M, F, Void, Ctx) ->
    case io:get_line(user, "") of % `user` is the real stdin; our group leader is /dev/null
        eof -> ok;
        {error, _} -> ok;
        Line ->
            [MinT, MaxR, _ | Rest] = string:lexemes(Line, " \n"),
            MinTime = to_number(MinT),
            MaxRuns = list_to_integer(MaxR),
            Reply = try
                run_timed(M, F, Void, Ctx, string:join(Rest, " "), MinTime, MaxRuns, 0.0, 0, undefined)
            catch
                Class:Reason -> iolist_to_binary([<<"{\"err\":">>, json_str(err_text(Class, Reason)), <<"}">>])
            end,
            io:put_chars(user, [<<1, "LV ">>, Reply, $\n]),
            loop_serve(M, F, Void, Ctx)
    end.

run_timed(M, F, Void, Ctx, Line, MinTime, MaxRuns, Total, Runs, Last) when Runs > 0, (Runs >= MaxRuns orelse Total >= MinTime) ->
    _ = {M, F, Void, Ctx, Line},
    iolist_to_binary(io_lib:format("{\"t\":~p,\"runs\":~p,\"mem\":-1,\"depth\":-1,\"out\":~s}", [Total / Runs, Runs, json(plain(Last))]));
run_timed(M, F, Void, Ctx, Line, MinTime, MaxRuns, Total, Runs, _) ->
    Args = read_args(Line, Ctx),
    T0 = erlang:monotonic_time(nanosecond),
    R = apply(M, F, Args),
    Dt = (erlang:monotonic_time(nanosecond) - T0) / 1.0e9,
    Out = case Void of true -> hd(Args); false -> R end,
    run_timed(M, F, Void, Ctx, Line, MinTime, MaxRuns, Total + Dt, Runs + 1, Out).

%% ------------------------------------------------------------------ trace

trace(Ctx) ->
    #{module := M, function := F, void := Void} = Ctx,
    {ok, Req} = read_all(),
    #{tokens := Tokens, max_steps := MaxSteps, out := OutFile, stdout := StdoutFile, names := Names, lines := Lines} = Req,
    Args = read_args(Tokens, Ctx),
    {ok, Out} = file:open(StdoutFile, [write, binary]),
    Self = self(),
    Worker = spawn(fun() -> receive go -> ok end, group_leader(Out, self()), Self ! {done, self(), catch_result(M, F, Args)} end),
    Ref = monitor(process, Worker),
    {module, M} = code:ensure_loaded(M), % trace patterns only apply to loaded modules
    erlang:trace(Worker, true, [call, {tracer, Self}]),
    erlang:trace_pattern({M, '_', '_'}, [{'_', [], [{exception_trace}]}], [local]),
    Worker ! go,
    {Steps, Result} = collect(Worker, Ref, MaxSteps, Names, Lines, [], [], 0),
    file:close(Out),
    Final = case Result of
                {ok, V} -> #{steps => Steps, returnPlain => json(plain(case Void of true -> hd(Args); false -> V end))};
                {error, Msg, Line} -> #{steps => Steps, error => Msg, errorLine => Line};
                truncated -> #{steps => Steps, truncated => true}
            end,
    file:write_file(OutFile, json(Final)).

catch_result(M, F, Args) ->
    try {ok, apply(M, F, Args)}
    catch Class:Reason -> {error, err_text(Class, Reason)}
    end.

read_all() -> read_all([]).
read_all(Acc) ->
    case io:get_line(standard_io, "") of
        eof -> {ok, decode_req(lists:flatten(lists:reverse(Acc)))};
        Line -> read_all([Line | Acc])
    end.

%% The request is tiny and flat: tokens, numbers, file paths and two small string maps,
%% sent by beam.js as Erlang terms (one per line) to avoid needing a JSON parser here.
decode_req(Text) ->
    {ok, Toks, _} = erl_scan:string(Text),
    {ok, Term} = erl_parse:parse_term(Toks),
    Term.

frame_locals(F, Args, Names) ->
    ArgNames = maps:get(atom_to_binary(F, utf8), Names, []),
    {ordered, [{arg_name(ArgNames, I), ser(A)} || {I, A} <- lists:zip(lists:seq(1, length(Args)), Args)]}.

arg_name(Names, I) when length(Names) >= I -> lists:nth(I, Names);
arg_name(_, I) -> iolist_to_binary(["arg", integer_to_list(I)]).

stack_json(Stack) ->
    Rev = lists:reverse(Stack),
    Depth = length(Rev),
    [case Depth - I < 6 of
         true -> #{fn => Fn, line => Line, locals => Locals};
         false -> #{fn => Fn, line => Line}
     end || {I, {Fn, Line, Locals}} <- lists:zip(lists:seq(0, Depth - 1), Rev)].

collect(Worker, Ref, MaxSteps, Names, Lines, Steps, Stack, N) when N >= MaxSteps ->
    exit(Worker, kill),
    flush(Ref),
    _ = {Names, Lines, Stack},
    {lists:reverse(Steps), truncated};
collect(Worker, Ref, MaxSteps, Names, Lines, Steps, Stack, N) ->
    receive
        {trace, Worker, call, {_, F, Args}} ->
            FnName = atom_to_binary(F, utf8),
            Line = maps:get(FnName, Lines, 1),
            Stack2 = [{FnName, Line, frame_locals(F, Args, Names)} | Stack],
            Step = #{line => Line, event => <<"call">>, stack => stack_json(Stack2), out => 0},
            collect(Worker, Ref, MaxSteps, Names, Lines, [Step | Steps], Stack2, N + 1);
        {trace, Worker, return_from, {_, _F, _}, Value} ->
            case Stack of
                [{_, Line, _} | Rest] ->
                    Step = #{line => Line, event => <<"return">>, stack => stack_json(Stack), out => 0, ret => ser(Value)},
                    collect(Worker, Ref, MaxSteps, Names, Lines, [Step | Steps], Rest, N + 1);
                [] -> collect(Worker, Ref, MaxSteps, Names, Lines, Steps, Stack, N)
            end;
        {trace, Worker, exception_from, {_, _F, _}, {Class, Reason}} ->
            case Stack of
                [{_, Line, _} | Rest] ->
                    Msg = err_text(Class, Reason),
                    Step = #{line => Line, event => <<"exception">>, stack => stack_json(Stack), out => 0, exc => Msg},
                    collect(Worker, Ref, MaxSteps, Names, Lines, [Step | Steps], Rest, N + 1);
                [] -> collect(Worker, Ref, MaxSteps, Names, Lines, Steps, Stack, N)
            end;
        {done, Worker, {ok, V}} ->
            flush(Ref),
            {lists:reverse(Steps), {ok, V}};
        {done, Worker, {error, Msg}} ->
            flush(Ref),
            Line = case [S || #{event := <<"exception">>} = S <- Steps] of
                       [#{line := L} | _] -> L;
                       [] -> null
                   end,
            {lists:reverse(Steps), {error, Msg, Line}};
        {'DOWN', Ref, process, Worker, Reason} ->
            {lists:reverse(Steps), {error, err_text(exit, Reason), null}};
        _Other ->
            collect(Worker, Ref, MaxSteps, Names, Lines, Steps, Stack, N)
    after 60000 ->
        exit(Worker, kill),
        {lists:reverse(Steps), truncated}
    end.

flush(Ref) ->
    receive {'DOWN', Ref, _, _, _} -> ok after 100 -> ok end.
