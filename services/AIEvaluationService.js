import axios from 'axios';

/**
 * AI Evaluation Service - Integrates with Claude Opus for CEFR assessment
 * This service evaluates spoken English and provides CEFR level assessment
 */
class AIEvaluationService {
  constructor() {
    this.apiKey = process.env.CLAUDE_API_KEY;
    this.model = process.env.CLAUDE_MODEL || 'claude-opus-5-20250805';
    this.apiUrl = 'https://api.anthropic.com/v1/messages';
    this.maxTokens = parseInt(process.env.CLAUDE_MAX_TOKENS) || 2000;
  }

  /**
   * Evaluate a speaking task response
   * @param {Object} taskData - Task data with transcription and metadata
   * @returns {Object} Evaluation results with scores and feedback
   */
  async evaluateTask(taskData) {
    try {
      const {
        transcription,
        taskType,
        question,
        cefrLevel,
        referenceImages,
        followUpQuestions
      } = taskData;

      if (!transcription || transcription.trim().length === 0) {
        return {
          score: 0,
          criteria: {
            grammar: { score: 0, feedback: 'No response provided' },
            vocabulary: { score: 0, feedback: 'No response provided' },
            fluency: { score: 0, feedback: 'No response provided' },
            pronunciation: { score: 0, feedback: 'Unable to assess - no audio' },
            coherence: { score: 0, feedback: 'No response provided' }
          },
          overallFeedback: 'No response was submitted for evaluation.',
          strengths: [],
          areasForImprovement: [],
          suggestedLevel: 'A1'
        };
      }

      const prompt = this.buildEvaluationPrompt(
        transcription,
        taskType,
        question,
        cefrLevel,
        referenceImages,
        followUpQuestions
      );

      const response = await this.callClaudeAPI(prompt);
      const evaluation = this.parseEvaluation(response);

      return evaluation;
    } catch (error) {
      console.error('Error in evaluateTask:', error);
      throw new Error(`AI Evaluation failed: ${error.message}`);
    }
  }

  /**
   * Build evaluation prompt for Claude Opus
   */
  buildEvaluationPrompt(
    transcription,
    taskType,
    question,
    cefrLevel,
    referenceImages,
    followUpQuestions
  ) {
    return `You are an expert CEFR English language assessment specialist. Evaluate the following English speaking response according to the CEFR framework.

TASK INFORMATION:
- Task Type: ${taskType}
- Target Level: ${cefrLevel}
- Question/Prompt: ${question}
${followUpQuestions ? `- Follow-up Questions: ${followUpQuestions.join(', ')}` : ''}
${referenceImages ? `- Reference Context: Image-based description task` : ''}

STUDENT'S RESPONSE (Transcribed):
"${transcription}"

Please evaluate this response and provide a detailed assessment in the following JSON format:

{
  "score": (0-100 numeric score),
  "criteria": {
    "grammar": {
      "score": (0-100),
      "feedback": "Specific feedback on grammatical accuracy, sentence structure, and complexity"
    },
    "vocabulary": {
      "score": (0-100),
      "feedback": "Feedback on vocabulary range, appropriateness, and use of idiomatic expressions"
    },
    "fluency": {
      "score": (0-100),
      "feedback": "Feedback on speech fluency, pace, hesitations, and natural delivery"
    },
    "pronunciation": {
      "score": (0-100),
      "feedback": "Assessment of pronunciation clarity (note: estimated from transcription accuracy)"
    },
    "coherence": {
      "score": (0-100),
      "feedback": "Feedback on logical organization, coherence, and task completion"
    }
  },
  "overallFeedback": "A comprehensive summary of the response quality and assessment",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "areasForImprovement": ["Area 1", "Area 2", "Area 3"],
  "suggestedLevel": "CEFR level (A1/A2/B1/B2/C1/C2)"
}

EVALUATION GUIDELINES:
- Score 0-35: A1 (Beginner)
- Score 35-50: A2 (Elementary)
- Score 50-65: B1 (Intermediate)
- Score 65-75: B2 (Upper Intermediate)
- Score 75-85: C1 (Advanced)
- Score 85-100: C2 (Mastery)

Be fair but rigorous in assessment. Consider accuracy, fluency, coherence, and appropriateness to the CEFR level.`;
  }

  /**
   * Call Claude API
   */
  async callClaudeAPI(prompt) {
    const payload = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    // Temperature is sent only when explicitly configured. Some models accept a
    // narrower range than others, and an unsupported value is rejected with a
    // 400 for the whole request — not worth risking for a grading task, where
    // the default (deterministic-leaning) sampling is what you want anyway.
    if (process.env.CLAUDE_TEMPERATURE !== undefined) {
      payload.temperature = Number(process.env.CLAUDE_TEMPERATURE);
    }

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      });

      return response.data.content[0].text;
    } catch (error) {
      // Axios reduces an API rejection to "Request failed with status code 400",
      // which hides the one thing that matters: which field was wrong. Surface
      // the API's own explanation, and name the likely cause per status code.
      const status = error.response?.status;
      const detail =
        error.response?.data?.error?.message ||
        (error.response?.data ? JSON.stringify(error.response.data).slice(0, 400) : error.message);

      const hint =
        status === 401 ? ' — CLAUDE_API_KEY is invalid'
        : status === 404 ? ` — model "${this.model}" does not exist; set CLAUDE_MODEL to one your key can use`
        : status === 400 ? ' — the request was rejected; check CLAUDE_MODEL, CLAUDE_MAX_TOKENS and CLAUDE_TEMPERATURE'
        : status === 429 ? ' — rate limited or out of credit'
        : '';

      throw new Error(`Claude API ${status || 'request'} failed: ${detail}${hint}`);
    }
  }

  /**
   * Parse Claude's JSON response
   */
  parseEvaluation(responseText) {
    try {
      // Extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const evaluation = JSON.parse(jsonMatch[0]);

      // Validate structure
      if (!evaluation.score || !evaluation.criteria || !evaluation.overallFeedback) {
        throw new Error('Invalid evaluation structure');
      }

      return evaluation;
    } catch (error) {
      console.error('Error parsing evaluation:', error);
      throw new Error(`Failed to parse AI evaluation: ${error.message}`);
    }
  }

  /**
   * Batch evaluate multiple tasks
   */
  async batchEvaluateTasks(tasks) {
    const results = [];

    for (const task of tasks) {
      try {
        const evaluation = await this.evaluateTask(task);
        results.push({
          taskNumber: task.taskNumber,
          success: true,
          evaluation
        });
      } catch (error) {
        results.push({
          taskNumber: task.taskNumber,
          success: false,
          error: error.message
        });
      }

      // Add delay between API calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Get CEFR level from score
   */
  static scoreToCEFRLevel(score) {
    if (score >= 85) return 'C2';
    if (score >= 75) return 'C1';
    if (score >= 65) return 'B2';
    if (score >= 50) return 'B1';
    if (score >= 35) return 'A2';
    return 'A1';
  }

  /**
   * Check if score passes the target level
   */
  static checkPassed(score, targetLevel) {
    const levelScores = {
      'A1': 0,
      'A2': 35,
      'B1': 50,
      'B2': 65,
      'C1': 75,
      'C2': 85
    };

    const requiredScore = levelScores[targetLevel] || 0;
    return score >= requiredScore;
  }
}

export default new AIEvaluationService();
