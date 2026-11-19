import { isIdentifierName } from "../core/secret-patterns.js";
import { isPlaceholderValue } from "../core/secret-shapes.js";
/**
 * `NAME=value` as an environment dump, a `.env` file or `docker inspect` prints it: an upper-case name with no space
 * around `=`. Source code writes `token = x` or `token: string`, so a Read or Grep of code passes. The value stops at
 * a space, a quote or a shell operator, save a URL's `&`, which joins its parameters; a quoted value is the
 * quoted-literal shape's.
 */
const ASSIGNMENT = /(?<![\w$])([A-Z][A-Z0-9_]*)=(<[^\s<>"'`;,&|()]*>[^\s"'`;,&|()<>]*|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`;,|()<>]+|[^\s"'`;,&|()<>]+)/g;
/**
 * `NAME: value` as a YAML or JSON map writes a variable (a Kubernetes secret's `stringData`, a compose file's
 * `environment`, an env map in JSON): the same upper-case name, bare or quoted, right before a colon and a space, then
 * a quoted or a bare value. No space before the colon, as a map writes it, so code's `x ? SECRET_KEY : y` is no key. A
 * bare value here stops where a flow map or code goes on, past a `${NAME}` or an angle placeholder it opens with; a
 * block map's value is read again from the line, as `blockValue` says.
 */
const MAPPING = /(?<![\w$])(["']?)([A-Z][A-Z0-9_]*)\1:[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[^\s{}]*\}[^\s"'`#,;{}[\]()<>]*|<[^\s<>"'`]*>[^\s"'`#,;{}[\]()<>]*|[^\s"'`#,;{}[\]()<>]+))/g;
/** What a flow map's key follows on its line (`{API_KEY: v, PORT: 80}`): its opening brace or the comma before it. */
const FLOW_OPENER = /[{,]/;
/** The blank space a key may follow on its line. */
const BLANK = /[ \t]/;
/** A line's end. */
const LINE_END = /[\r\n]/;
/** A YAML comment after a value: `#` after a blank; a `#` inside a value has none before it. */
const COMMENT = /[ \t]#/;
/** Where a block value's first word ends: a blank, as the `NAME=value` form stops there too. */
const WORD_END = /\s/;
/**
 * A whole value that only refers to one filled in later: a GitHub workflow expression (`${{ secrets.GH_TOKEN }}`), a
 * Kubernetes `$(OTHER_VAR)` or a shell's `$(command)`. Anything glued on after it is still a value.
 */
const REFERENCE = /^\$(?:\{\{[^}]*\}\}|\([^()]*\))$/;
/**
 * A member of an object literal or a type, as code writes one under a capitalised key (`config.apiKey,`,
 * `fs.readFileSync(path),`, `readonly string[];`, `string | undefined;`): a name or a member chain, then a call, array
 * brackets or more words, closed by the `,` or `;` that ends a member. A block YAML value has no such close.
 */
const CODE_MEMBER = /^(?:readonly[ \t]+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(.*\)|(?:\[\])*|[ \t].*)[,;]$/;
/** A quoted value with a space in it: a message, a sentence or an expression, never a key. */
const SPACED = /\s/;
/** A name or a member chain in code (`config.apiKey`, `fs.readFileSync`), as code puts one after a capitalised key. */
const CODE_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** A YAML block scalar's marker (`|`, `>-`): the value opens on the lines below, so the line holds none. */
const BLOCK_SCALAR = /^[|>][-+\d]*$/;
/**
 * The one placeholder a whole value may be: a printf conversion (`%s`, `%-10s`), `$NAME`, `${NAME}` or an angle
 * placeholder. Exact, so anything glued on (`%sAKIA...`, `$X-secret`, `<x>sk-...`) is still a value. `${NAME:-default}`
 * is not one: a default is a value.
 */
const EXACT_PLACEHOLDER = /^(?:%[-+ #0]*\d*[sdqvx]|\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|<[^\s<>]*>)$/;
/** A value that opens like a placeholder, so only an exact one passes. */
const PLACEHOLDER_OPENING = /^[%$<]/;
/** A shell or printf `\n` written as two characters, where a printf format line ends a value. */
const NEWLINE_ESCAPE = '\\n';
/** A URL's userinfo, path, query and fragment, the parts that can carry a secret; the scheme and the host never do. */
const URL_PARTS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:([^/?#]*)@)?[^/?#]*([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
/** A path segment shaped like a token, as a webhook URL carries its secret: 16 or more word characters, a letter and a digit among them. */
const TOKEN_SEGMENT = /^(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{16,}$/;
/** A number: a limit, a port or a count (`TOKEN_LIMIT=200000`). */
const NUMBER = /^\d+(?:\.\d+)?$/;
/** A path to the secret, not the secret: `KEY_FILE=/a/b.pem`, `C:\k.pem`, `~/.ssh/id`, `./key`. */
const PATH = /^(?:[A-Za-z]:)?[\\/~.]/;
/**
 * One plain word, lower-case or with one leading capital: a mode, a kind or a role (`AUTH_MODE=oauth`,
 * `TOKEN_TYPE=bearer`, a role setting holding `Viewer`). The capital adds one bit to a word that already passed, so a
 * guessable word stays as weak as before (T2399: a Title-case role in a pod env listing filed a rotate task).
 */
const PLAIN_WORD = /^[A-Z]?[a-z]+$/;
/** Git's own variable for a setting's name; the setting's value sits in `GIT_CONFIG_VALUE_<n>`. */
const GIT_CONFIG_KEY = /^GIT_CONFIG_KEY_\d+$/;
/** A section and a dot, which git requires of every setting's name (`core.hooksPath`). */
const GIT_SETTING = /^[A-Za-z][A-Za-z0-9-]*\./;
/**
 * A function's name: camelCase or PascalCase words of letters, each with a vowel (`buildSessionHelper`). An env dump, a
 * `.env` file or `docker inspect` never prints `NAME=value(`, so such a name right before `(` is a call in code or
 * notes (T1924: `TOKEN=makeToken(` in a handover). A token-shaped run (`Qx7mRt`, `RtwLpwZn`) has a digit or a hump
 * with no vowel, so it stays a hit before `(` too.
 */
const CALLEE = /^(?:[a-z]+|[A-Z][a-z]+)(?:[A-Z][a-z]+)*$/;
const CALLEE_HUMP = /[A-Z]?[a-z]+/g;
const VOWEL = /[aeiouy]/;
function secretHit(value) {
    return { id: 'env-assignment', description: 'value of a secret variable', value };
}
/** True when `value`, followed in the text by `next`, is the name of a function the text calls. */
function isCall(value, next) {
    return next === '(' && isWordsName(value);
}
/** True when `value` is camelCase or PascalCase words, each with a vowel (`apiKey`, `SecretShapeHit`): code's name, not a token. */
function isWordsName(value) {
    return CALLEE.test(value) && Array.from(value.matchAll(CALLEE_HUMP), ([hump]) => hump).every((hump) => VOWEL.test(hump));
}
/**
 * True when a map's bare `value`, followed in the text by `next`, is code: a member chain it calls (`fs.readFileSync(`),
 * or one of words names (`config.apiKey`, a type). A YAML or JSON value runs to its line's end, never into `(`.
 */
function isCodeName(value, next) {
    return CODE_CHAIN.test(value) && (next === '(' || value.split('.').every(isWordsName));
}
/**
 * The value a map's key at `at` in `text` holds, its match ending at `end`, or none when it holds no value: a quoted
 * one but for a sentence, a flow map's bare one up to where the map goes on but for code, a block map's as `blockValue`
 * reads it.
 */
function mappedValue(text, at, end, quoted, bare) {
    if (quoted !== undefined)
        return quoted === '' || SPACED.test(quoted) ? undefined : quoted;
    if (bare === undefined)
        return undefined;
    if (!opensFlowMap(text, at))
        return blockValue(text, end - bare.length);
    return BLOCK_SCALAR.test(bare) || isCodeName(bare, text[end]) ? undefined : bare;
}
/** True when the key at `at` in `text` opens a flow map: a `{` or a `,` comes right before it on its line. */
function opensFlowMap(text, at) {
    let before = at - 1;
    while (before >= 0 && BLANK.test(text.charAt(before)))
        before -= 1;
    return before >= 0 && FLOW_OPENER.test(text.charAt(before));
}
/**
 * True when a block map's `line` value is a member of an object literal or a type in code, not a value: a call, or a
 * chain of words names or of an identifier's name (`process.env.SECRET_KEY`). A token-shaped chain stays a value.
 */
function isCodeMember(line) {
    const member = CODE_MEMBER.exec(line);
    if (member === null)
        return false;
    const [, chain = '', rest = ''] = member;
    return rest.startsWith('(') || isIdentifierName(chain) || chain.split('.').every(isWordsName);
}
/**
 * A block map's value, from `start` in `text`: none for a block scalar's marker, a reference or a member of code, else
 * the line's first word, with no comment. YAML keeps `#`, `,`, `(`, `[`, `{`, `;`, `<` and `>` inside a
 * block value, so a generated password holding one is a value to its first blank, never cut where a flow map's would
 * be (T2957 N1).
 */
function blockValue(text, start) {
    const rest = text.slice(start);
    const lineEnd = rest.search(LINE_END);
    const line = lineEnd < 0 ? rest : rest.slice(0, lineEnd);
    const comment = line.search(COMMENT);
    const value = (comment < 0 ? line : line.slice(0, comment)).trimEnd();
    if (BLOCK_SCALAR.test(value) || REFERENCE.test(value) || isCodeMember(value))
        return undefined;
    const wordEnd = value.search(WORD_END);
    const word = wordEnd < 0 ? value : value.slice(0, wordEnd);
    return word === '' ? undefined : word;
}
/**
 * The output-only shape of T1369 R7: the value of a secret variable, the name judged by the team's `SecretNames`.
 * Output is not prose, so the unquoted form is in here; prompts and notes stay without it.
 */
export class EnvAssignments {
    names;
    constructor(names) {
        this.names = names;
    }
    /**
     * Every secret variable's value in `text`, `NAME=value` or a map's `NAME: value`, in the order found; a value that
     * only names or points to one passes.
     */
    hitsIn(text) {
        return [...this.assignedIn(text), ...this.mappedIn(text)].sort((a, b) => a.at - b.at).map(({ hit }) => hit);
    }
    /** The secret values `NAME=value` assigns in `text`, each with where its assignment starts. */
    assignedIn(text) {
        const found = [];
        for (const match of text.matchAll(ASSIGNMENT)) {
            const [whole, name = '', value = ''] = match;
            const end = value.indexOf(NEWLINE_ESCAPE);
            // A printf format line runs its assignments together with `\n`: the value ends at the escape, and what follows is
            // scanned again as text, so a real secret after a placeholder is still found.
            if (end >= 0 && EXACT_PLACEHOLDER.test(value.slice(0, end))) {
                found.push(...this.assignedIn(value.slice(end + NEWLINE_ESCAPE.length)).map(({ hit }) => ({ at: match.index, hit })));
                continue;
            }
            if (this.isSecretValue(name, value, text[match.index + whole.length]))
                found.push({ at: match.index, hit: secretHit(value) });
        }
        return found;
    }
    /** The secret values a YAML or JSON map's `NAME: value` holds in `text`, each with where its key starts. */
    mappedIn(text) {
        const found = [];
        for (const match of text.matchAll(MAPPING)) {
            const [whole, , name = '', double, single, bare] = match;
            const end = match.index + whole.length;
            const value = mappedValue(text, match.index, end, double ?? single, bare);
            if (value === undefined)
                continue;
            const next = text[end - (bare ?? '').length + value.length];
            if (this.isSecretValue(name, value, next))
                found.push({ at: match.index, hit: secretHit(value) });
        }
        return found;
    }
    /** True when `value`, assigned to `name` and followed in the text by `next`, is a secret variable's value. */
    isSecretValue(name, value, next) {
        return this.names.secret(name) && this.holdsSecret(name, value) && !isCall(value, next);
    }
    /**
     * True when `value`, assigned to `name`, holds a secret. A URL is judged by the parts that carry one (T1549): its login
     * and password, a query or fragment parameter with a secret name, a token-shaped path segment. A connection string
     * without them, its credential a file on disk, is plain; one with them is a hit as a whole. A git setting's name is
     * plain, but only past the URL test: `url.<base>.insteadOf` holds a URL, whose login can be a token (T2001).
     */
    holdsSecret(name, value) {
        const url = URL_PARTS.exec(value);
        if (url === null)
            return !isPlainValue(value) && !isGitSetting(name, value);
        const [, userinfo = '', path = '', query = '', fragment = ''] = url;
        const [login = '', ...password] = userinfo.split(':');
        const parts = [
            login,
            password.join(':'),
            ...path.split('/').filter((segment) => TOKEN_SEGMENT.test(segment)),
            ...secretParamValues(`${query}&${fragment}`, (name) => this.names.secret(name)),
        ];
        return parts.some((part) => !isPlainValue(part));
    }
}
/** The values of the `&`-joined `name=value` parameters in `params` whose name `secret` takes for a secret one. */
function secretParamValues(params, secret) {
    return params.split('&').flatMap((param) => {
        const equals = param.indexOf('=');
        return equals > 0 && secret(param.slice(0, equals)) ? [param.slice(equals + 1)] : [];
    });
}
/** True when `value` is the name of a git setting, assigned to git's own variable for one. */
function isGitSetting(name, value) {
    return GIT_CONFIG_KEY.test(name) && GIT_SETTING.test(value);
}
/** True when an assigned `value` is not a secret: a placeholder, a name, a number, a path or a plain word. */
function isPlainValue(value) {
    // `$` alone is what stops at a `$(command)`; any longer value opening with a placeholder must be exactly one.
    if (value !== '$' && PLACEHOLDER_OPENING.test(value))
        return EXACT_PLACEHOLDER.test(value);
    return isPlaceholderValue(value) || isIdentifierName(value) || NUMBER.test(value) || PATH.test(value) || PLAIN_WORD.test(value);
}
