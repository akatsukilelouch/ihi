import { TSESTree } from "@typescript-eslint/typescript-estree";

export function createFileContext(file: string, buffer: string) {
  let errorStack: {
    text: string;
    notes: string[];
  }[] = [];

  return {
    file,
    buffer,
    lines: buffer.split("\n"),

    getLineContext(location: TSESTree.SourceLocation, context: number = 2) {
      let lowerBound = location.start.line - 1 - context;
      if (lowerBound < 0) lowerBound = 0;

      let upperBound = location.end.line + context;
      if (upperBound >= this.lines.length) upperBound = this.lines.length;

      let lines: { line: number; highlight?: number; text: string }[] = [];

      for (let i = lowerBound; i < upperBound; ++i) {
        const highlight = i == location.start.line - 1;

        lines.push({
          line: i + 1,
          highlight: highlight ? location.start.column : undefined,
          text: this.lines[i],
        });
      }

      return lines;
    },

    pushError(location: TSESTree.SourceLocation, error: any) {
      const report = String(error);
      // report = report[0].toUpperCase() + report.slice(1) + ".";

      const lineContext = this.getLineContext(location);
      const lineMaximum = lineContext.reduce(
        (a, { line }) => (a < line ? line : a),
        0,
      );

      const padding = lineMaximum.toString().length;

      const context = lineContext
        .flatMap(({ line, highlight, text }) => {
          const leftPart = `| ${line.toString().padStart(padding)} | `;

          if (highlight) {
            let selector = "";
            for (let i = 0; i < highlight + leftPart.length; ++i) {
              selector += " ";
            }

            selector += "^ - " + report;

            return [leftPart + text, selector];
          } else {
            return [leftPart + text];
          }
        })
        .join("\n    ");

      errorStack.push({
        text: `${this.file}:${location.start.line}:${location.start.column + 1}:\n    ${context}`,
        notes: [],
      });
    },

    pushNote(note: string) {
      errorStack[errorStack.length - 1].notes.push("\n    note: " + note);
    },

    discardErrors() {
      errorStack = [];
    },

    reportErrors() {
      if (errorStack.length > 0) {
        errorStack.reverse();

        const { text, notes } = errorStack[0];
        console.error(text);
        for (const note of notes) {
          console.error(note);
        }

        if (errorStack.length > 1) {
          console.error("caused by...");

          for (let i = 1; i < errorStack.length; ++i) {
            const { text, notes } = errorStack[i];

            console.error(
              text
                .split("\n")
                .map((v) => "  " + v)
                .join("\n"),
            );
            for (const note of notes) {
              console.error(
                note
                  .split("\n")
                  .map((v) => "  " + v)
                  .join("\n"),
              );
            }

            if (i !== errorStack.length - 1) console.error("  caused by...");
          }
        }

        errorStack = [];

        return true;
      } else {
        return false;
      }
    },

    readLoc(loc: TSESTree.SourceLocation) {
      if (loc.start.line === loc.end.line)
        return this.lines[loc.start.line - 1].slice(loc.start.column, loc.end.column);

      let string = this.lines[loc.start.line - 1].slice(loc.start.column);

      let i = loc.start.line;
      for (; i < loc.end.line - 1; ++i) {
        string += this.lines[i];
      }

      if (i < loc.end.line)
        string += this.lines[i].slice(0, loc.end.column);

      return string;
    },
  };
}

export type FileContext = ReturnType<typeof createFileContext>;
