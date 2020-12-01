const openapi = require('@redocly/openapi-core');
const yamlAst = require('yaml-ast-parser');
const core = require('@actions/core');
const github = require('@actions/github');

const batch = (size, inputs) => inputs.reduce((batches, input) => {
    const current = batches[batches.length - 1]
  
    current.push(input)
  
    if (current.length === size) {
      batches.push([])
    }
  
    return batches
}, [[]]);

const stats = function (annotations) {
    const annotationsPerLevel = annotations.reduce((acc, annotation) => {
      const level = annotation.annotation_level
      let annotations
      if (level in acc) {
        annotations = acc[level]
      } else {
        annotations = []
        acc[level] = annotations
      }
      annotations.push(annotation)
      return acc
    }, {})
    const failureCount = (annotationsPerLevel['failure'] || []).length || 0
    const warningCount = (annotationsPerLevel['warning'] || []).length || 0
    const noticeCount = (annotationsPerLevel['notice'] || []).length || 0
    return { failureCount, warningCount, noticeCount }
}

const generateConclusion = function (failureCount, warningCount, noticeCount) {
    let conclusion = 'success'
    if (failureCount > 0) {
      conclusion = 'failure'
    } else if (warningCount > 0 || noticeCount > 0) {
      conclusion = 'neutral'
    }
    return conclusion
}

const generateSummary = function (failureCount, warningCount, noticeCount) {
    const messages = []
    if (failureCount > 0) {
      messages.push(`${failureCount} failure(s) found`)
    }
    if (warningCount > 0) {
      messages.push(`${warningCount} warning(s) found`)
    }
    if (noticeCount > 0) {
      messages.push(`${noticeCount} notice(s) found`)
    }
    return messages.join('\n')
}

function getLineColLocation(location) {
    if (location.pointer === undefined) return location;
  
    const { source, pointer, reportOnKey } = location;
    const ast = source.getAst();
    const astNode = getAstNodeByPointer(ast, pointer, !!reportOnKey);
    var startPosition = 1;
    var endPosition = 1;
    if(astNode != undefined && astNode.startPosition != undefined)
        startPosition = astNode.startPosition;
    if(astNode != undefined && astNode.endPosition != undefined)
        endPosition = astNode.endPosition;
    const pos = positionsToLoc(source.body, startPosition, endPosition);
    return {
      ...pos
    };
}
  
function positionsToLoc(
    source,
    startPos,
    endPos,
  ) {
    let currentLine = 1;
    let currentCol = 1;
    let start = { line: 1, col: 1 };
  
    for (let i = 0; i < endPos - 1; i++) {
      if (i === startPos - 1) {
        start = { line: currentLine, col: currentCol + 1 };
      }
      if (source[i] === '\n') {
        currentLine++;
        currentCol = 1;
        if (i === startPos - 1) {
          start = { line: currentLine, col: currentCol };
        }
  
        if (source[i + 1] === '\r') i++; // TODO: test it
        continue;
      }
      currentCol++;
    }
  
    const end = startPos === endPos ? { ...start } : { line: currentLine, col: currentCol + 1 };
    return { start, end };
}

function unescapePointer(fragment) {
    return decodeURIComponent(fragment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function parsePointer(pointer) {
    return pointer.substr(2).split('/').map(unescapePointer);
}
  
function getAstNodeByPointer(root, pointer, reportOnKey) {
    const pointerSegments = parsePointer(pointer);
    if (root === undefined) {
      return undefined;
    }
  
    let currentNode = root;
    for (const key of pointerSegments) {
      if (currentNode.kind === yamlAst.Kind.MAP) {
        const mapping = currentNode.mappings.find((m) => m.key.value === key);
        if (!mapping && !mapping.value) break;
        currentNode = mapping.value;
      } else if (currentNode.kind === yamlAst.Kind.SEQ) {
        const elem = currentNode.items[parseInt(key, 10)];
        if (!elem) break;
        currentNode = elem;
      }
    }
  
    if (!reportOnKey) {
      return currentNode;
    } else {
      const parent = currentNode.parent;
      if (!parent) return currentNode;
      if (parent.kind === yamlAst.Kind.SEQ) {
        return currentNode;
      } else if (parent.kind === yamlAst.Kind.MAPPING) {
        return parent.key;
      } else {
        return currentNode;
      }
    }
}

async function exec () {
    const config = await openapi.loadConfig(undefined);
    const lintData = await openapi.lint({
        ref: 'swagger.json',
        config: config
    });

    const findings = [];
    for(var i = 0; i < lintData.length; i++) {
        const finding = lintData[i];
        const location = finding.location[0];
        const line = getLineColLocation(location);
        findings.push({
            path: 'swagger.json',
            start_line: line.start.line,
            end_line: line.end.line,
            start_column: line.start.col,
            end_column: line.end.col,
            title: `${finding.ruleId} - ${location.pointer}`,
            message: finding.message,
            annotation_level: finding.severity === 'error' ? 'failure' : finding.severity == 'warn' ? 'warning' : 'notice'
        });
    }

    const octokit = new github.getOctokit(core.getInput('github_token', { required: true }));
    const ref = github.context.sha;
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;
    const title = 'Open API Lint Check';
    const { failureCount, warningCount, noticeCount } = stats(findings);
    const conclusion = generateConclusion(failureCount, warningCount, noticeCount);
    const summary = generateSummary(failureCount, warningCount, noticeCount);

    const { data: { id: checkRunId } } = await octokit.checks.create({
        owner,
        repo,
        name: title,
        head_sha: ref,
        status: 'in_progress'
    });

    const batchFindings = batch(50, findings);
    for(const batch in batchFindings) {
        await octokit.checks.update({
            owner,
            repo,
            check_run_id: checkRunId,
            status: 'completed',
            conclusion,
            output: {
                title,
                summary,
                batch
            }
        });
    }
}

exec();