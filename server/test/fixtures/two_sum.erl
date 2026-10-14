-spec two_sum(Nums :: [integer()], Target :: integer()) -> [integer()].
two_sum(Nums, Target) ->
  find(Nums, Target, 0, #{}).

find([], _Target, _I, _Seen) -> [];
find([X | Rest], Target, I, Seen) ->
  case maps:find(Target - X, Seen) of
    {ok, J} -> [J, I];
    error -> find(Rest, Target, I + 1, Seen#{X => I})
  end.
