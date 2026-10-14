// Adds LeetViz trace probes to a C# solution with Roslyn (the C# compiler's own API).
//
//   dotnet lvinstrument.dll <Solution.cs> <out.cs> <refs.txt> <other sources...>
//
// Every probe is inserted on the line of the code it belongs to, so line numbers don't move:
//   statement          ->  LvT.L(line, "a", a, "b", b); statement
//   return expr;       ->  return LvT.R(line, expr);
//   while (cond)       ->  while (LvT.B(line, ...) && (cond))
//   method body { ... } -> { LvT.Enter("name", line, ...); try { ... } finally { LvT.Exit(); } }
// The variables passed are the ones Roslyn's data-flow analysis says are definitely assigned and
// in scope at that point, so the trace never shows an uninitialized local.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

public static class LvInstrument {
    sealed record Edit(int Start, int End, string Text, int Order);

    static SemanticModel model;
    static SyntaxTree tree;
    static readonly List<Edit> edits = new();
    static int order;

    static void Insert(int pos, string text) => edits.Add(new Edit(pos, pos, text, order++));
    static void Replace(int start, int end, string text) => edits.Add(new Edit(start, end, text, order++));

    static int Line(SyntaxNode n) => tree.GetLineSpan(n.Span).StartLinePosition.Line + 1;
    static int LineOf(SyntaxToken t) => tree.GetLineSpan(t.Span).StartLinePosition.Line + 1;

    static bool Usable(ITypeSymbol t) => t != null && !t.IsRefLikeType && t.TypeKind != TypeKind.Pointer && t.TypeKind != TypeKind.FunctionPointer;

    /// <summary>"name", name, ... for the variables worth showing at this point.</summary>
    static string Vars(SyntaxNode at, DataFlowAnalysis flow, IMethodSymbol method) {
        var inScope = model.LookupSymbols(at.SpanStart).ToHashSet(SymbolEqualityComparer.Default);
        var assigned = flow != null && flow.Succeeded ? flow.DefinitelyAssignedOnEntry.ToHashSet(SymbolEqualityComparer.Default) : new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        var names = new List<string>();
        var taken = new HashSet<string>();
        // Fields of the solution class first (memo tables etc.), unless a local shadows them.
        var locals = new List<string>();
        foreach (var s in model.LookupSymbols(at.SpanStart)) {
            if (s is IParameterSymbol p && assigned.Contains(p) && Usable(p.Type) && p.RefKind != RefKind.Out) locals.Add(p.Name);
            else if (s is ILocalSymbol l && assigned.Contains(l) && Usable(l.Type) && !l.IsRef) locals.Add(l.Name);
        }
        // Parameters before locals, each in declaration order.
        locals = locals.OrderBy(n => model.LookupSymbols(at.SpanStart, name: n).FirstOrDefault() is IParameterSymbol ? 0 : 1)
                       .ThenBy(n => model.LookupSymbols(at.SpanStart, name: n).FirstOrDefault()?.Locations.FirstOrDefault()?.SourceSpan.Start ?? 0).ToList();
        foreach (var n in locals) if (taken.Add(n)) names.Add(n);
        if (method != null && method.ContainingType != null) {
            foreach (var f in method.ContainingType.GetMembers().OfType<IFieldSymbol>()) {
                if (f.IsImplicitlyDeclared || !Usable(f.Type) || taken.Contains(f.Name) || (!f.IsStatic && method.IsStatic) || f.IsConst) continue;
                if (!inScope.Contains(f)) continue;
                taken.Add(f.Name);
                names.Add(f.Name);
            }
        }
        return string.Concat(names.Select(n => $", \"{n}\", {n}"));
    }

    static DataFlowAnalysis Flow(StatementSyntax s) {
        try { return model.AnalyzeDataFlow(s); } catch { return null; }
    }

    static DataFlowAnalysis Flow(ExpressionSyntax e) {
        try { return model.AnalyzeDataFlow(e); } catch { return null; }
    }

    // ------------------------------------------------------------------ statements

    static void Statements(IEnumerable<StatementSyntax> list, IMethodSymbol method, bool isVoid) {
        foreach (var s in list) Statement(s, method, isVoid, inBlock: true);
    }

    /// <summary>Probe before s; recurse into nested statements (wrapping single statements in braces).</summary>
    static void Statement(StatementSyntax s, IMethodSymbol method, bool isVoid, bool inBlock) {
        if (s is LocalFunctionStatementSyntax lf) { LocalFunction(lf); return; }
        if (s is BlockSyntax block && inBlock) { Statements(block.Statements, method, isVoid); return; }
        bool wrap = !inBlock && s is not BlockSyntax;
        if (wrap) Insert(s.SpanStart, "{ ");
        if (s is BlockSyntax b) { Statements(b.Statements, method, isVoid); return; }
        if (s is not LabeledStatementSyntax) Insert(s.SpanStart, $"LvT.L({Line(s)}{Vars(s, Flow(s), method)}); ");

        switch (s) {
            case ReturnStatementSyntax r:
                if (r.Expression != null && method != null && !method.ReturnsVoid && Usable(method.ReturnType) && !method.ReturnsByRef) {
                    // Explicit type argument: `return null;`, `return [];` and `return new();` need the target type.
                    Insert(r.Expression.SpanStart, $"LvT.R<{method.ReturnType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}>({Line(r)}, ");
                    Insert(r.Expression.Span.End, ")");
                } else if (r.Expression == null) {
                    Insert(r.SpanStart, $"LvT.RV({Line(r)}); ");
                }
                break;
            case IfStatementSyntax i:
                Statement(i.Statement, method, isVoid, false);
                if (i.Else != null) {
                    if (i.Else.Statement is IfStatementSyntax elif) {
                        // `else if`: probe the nested if like any statement, inside braces.
                        Statement(elif, method, isVoid, false);
                    } else {
                        Statement(i.Else.Statement, method, isVoid, false);
                    }
                }
                break;
            case WhileStatementSyntax w:
                Insert(w.Condition.SpanStart, $"LvT.B({Line(w)}{Vars(w.Condition, Flow(w.Condition), method)}) && (");
                Insert(w.Condition.Span.End, ")");
                Statement(w.Statement, method, isVoid, false);
                break;
            case DoStatementSyntax d:
                Insert(d.Condition.SpanStart, $"LvT.B({LineOf(d.WhileKeyword)}{Vars(d.Condition, Flow(d.Condition), method)}) && (");
                Insert(d.Condition.Span.End, ")");
                Statement(d.Statement, method, isVoid, false);
                break;
            case ForStatementSyntax f:
                if (f.Condition != null) {
                    Insert(f.Condition.SpanStart, $"LvT.B({Line(f)}{Vars(f.Condition, Flow(f.Condition), method)}) && (");
                    Insert(f.Condition.Span.End, ")");
                }
                Statement(f.Statement, method, isVoid, false);
                break;
            case CommonForEachStatementSyntax fe: {
                // Show the foreach line once per item, with the loop variable set.
                var body = fe.Statement;
                var first = body is BlockSyntax bb ? bb.Statements.FirstOrDefault() : body;
                var vars = first != null ? Vars(first, Flow(first), method) : "";
                if (body is BlockSyntax bl) Insert(bl.OpenBraceToken.Span.End, $" LvT.L({Line(fe)}{vars});");
                else { Insert(body.SpanStart, $"{{ LvT.L({Line(fe)}{vars}); "); }
                if (body is BlockSyntax bl2) Statements(bl2.Statements, method, isVoid);
                else { Statement(body, method, isVoid, true); Insert(body.Span.End, " }"); }
                break;
            }
            case SwitchStatementSyntax sw:
                foreach (var sec in sw.Sections) Statements(sec.Statements, method, isVoid);
                break;
            case TryStatementSyntax t:
                Statements(t.Block.Statements, method, isVoid);
                foreach (var c in t.Catches) Statements(c.Block.Statements, method, isVoid);
                if (t.Finally != null) Statements(t.Finally.Block.Statements, method, isVoid);
                break;
            case LockStatementSyntax l: Statement(l.Statement, method, isVoid, false); break;
            case UsingStatementSyntax u: Statement(u.Statement, method, isVoid, false); break;
            case CheckedStatementSyntax c: Statements(c.Block.Statements, method, isVoid); break;
            case UnsafeStatementSyntax us: Statements(us.Block.Statements, method, isVoid); break;
            case FixedStatementSyntax fx: Statement(fx.Statement, method, isVoid, false); break;
            case LabeledStatementSyntax ls: Statement(ls.Statement, method, isVoid, false); break;
        }
        if (wrap) Insert(s.Span.End, " }");
    }

    // ------------------------------------------------------------------ method-like bodies

    static bool HasYield(SyntaxNode body) => body.DescendantNodes(n => n is not AnonymousFunctionExpressionSyntax && n is not LocalFunctionStatementSyntax).Any(n => n is YieldStatementSyntax);

    static string Params(IMethodSymbol m) => string.Concat(m.Parameters.Where(p => Usable(p.Type) && p.RefKind != RefKind.Out).Select(p => $", \"{p.Name}\", {p.Name}"));

    static void Body(SyntaxNode decl, BlockSyntax body, ArrowExpressionClauseSyntax arrow, SyntaxToken semicolon, IMethodSymbol m, string name) {
        if (m == null || (body == null && arrow == null)) return;
        if (body != null && HasYield(body)) return;
        bool isVoid = m.ReturnsVoid || m.IsAsync;
        string enter = $"LvT.Enter(\"{name}\", {Line(decl)}{Params(m)}); try {{";
        if (body != null) {
            Insert(body.OpenBraceToken.Span.End, " " + enter);
            Statements(body.Statements, m, isVoid);
            if (isVoid) Insert(body.CloseBraceToken.SpanStart, $"LvT.RV({LineOf(body.CloseBraceToken)}); ");
            Insert(body.CloseBraceToken.SpanStart, "} finally { LvT.Exit(); } ");
        } else {
            // `=> expr;` becomes a block on the same line(s).
            var e = arrow.Expression;
            var text = e.ToString();
            int line = Line(e);
            string ret = m.ReturnType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            string inner = isVoid ? $"LvT.L({line}{Params(m)}); {text}; LvT.RV({line});"
                : Usable(m.ReturnType) ? $"LvT.L({line}{Params(m)}); return LvT.R<{ret}>({line}, {text});" : $"LvT.L({line}{Params(m)}); return {text};";
            Replace(arrow.SpanStart, semicolon.Span.End, $"{{ {enter} {inner} }} finally {{ LvT.Exit(); }} }}");
        }
    }

    static void LocalFunction(LocalFunctionStatementSyntax lf) {
        var m = model.GetDeclaredSymbol(lf) as IMethodSymbol;
        Body(lf, lf.Body, lf.ExpressionBody, lf.SemicolonToken, m, lf.Identifier.Text);
    }

    public static int Main(string[] argv) {
        string src = argv[0], dst = argv[1];
        var refs = File.ReadAllLines(argv[2]).Where(l => l.Trim() != "").Select(p => MetadataReference.CreateFromFile(p)).ToList();
        var parse = new CSharpParseOptions(LanguageVersion.Latest);
        tree = CSharpSyntaxTree.ParseText(File.ReadAllText(src), parse, path: src);
        var others = argv.Skip(3).Select(p => CSharpSyntaxTree.ParseText(File.ReadAllText(p), parse, path: p));
        var comp = CSharpCompilation.Create("lv", new[] { tree }.Concat(others), refs, new CSharpCompilationOptions(OutputKind.ConsoleApplication, allowUnsafe: true));
        model = comp.GetSemanticModel(tree);
        var root = tree.GetRoot();
        foreach (var md in root.DescendantNodes().OfType<MethodDeclarationSyntax>()) {
            Body(md, md.Body, md.ExpressionBody, md.SemicolonToken, model.GetDeclaredSymbol(md), md.Identifier.Text);
        }
        // Apply edits back to front; at the same position keep insertion order.
        var text = File.ReadAllText(src);
        foreach (var e in edits.OrderByDescending(e => e.Start).ThenByDescending(e => e.Order)) {
            text = text.Substring(0, e.Start) + e.Text + text.Substring(e.End);
        }
        File.WriteAllText(dst, text);
        return 0;
    }
}
